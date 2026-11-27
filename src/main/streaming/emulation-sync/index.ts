import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import type { Logger } from '../../logger'
import { renameRetry, RM_RETRY } from '../../util/fs'
import { Backups, realInside } from './files'
import { heldKeys, planSync, type BaseEntry, type SyncAction } from './plan'
import { absolutePath, cleanSyncPath, FOLDER_ID_FILE, syncKey, type SyncScope } from './rules'
import { HashIndex, scanFolder, sha1File, writeJsonAtomic, type SyncFile } from './scan'
import {
  UPLOAD_CHUNK_BYTES,
  type EmulationCommit,
  type EmulationDelete,
  type EmulationManifest,
  type EmulationTransport
} from './types'
import { tMain } from '../../i18n'

/**
 * Keeps the Emulation folder the same on a host and its paired clients, both ways (Settings › Streaming). Only a
 * client can reach the other PC (the host runs the server), so each client drives the sync with each of its hosts:
 * it fetches the host's list of files, merges it with its own (plan.ts), then downloads, uploads and deletes. The
 * host is the meeting point: a change one client sends reaches the others at their next pass.
 *
 * Nothing is replaced in place: a downloaded file is written beside its target and renamed over it, an uploaded one
 * is staged in the host's Emulation folder (`uploads.playout-sync`, on the same drive) and renamed over its target
 * once it is whole and checked. A copy that loses a conflict is copied to the backups first; a deleted one is moved
 * there. No write goes through a junction or a short (8.3) name (files.ts realInside).
 *
 * State, in `stateDir` (userData\streaming\emulation-sync, outside the Emulation folder):
 * - hosts\<host>.json: per host, the files both PCs had after the last sync (the merge's base);
 * - client-index.json / host-index.json: remembered hashes;
 * - backups\: replaced and deleted files (30 days).
 */

export interface EmulationSyncDeps {
  stateDir: string
  log: Logger
  now?: () => number
  /** A file written less than this long ago is still being saved: it waits for a later pass. Default 30 s. */
  settleMs?: number
  /** Bytes free on the drive of `dir`, or null when unknown. */
  freeBytes?: (dir: string) => Promise<number | null>
}

/** The host refuses a sync request; `status` and `code` go back to the client as the answer. */
export class SyncRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'SyncRefused'
  }
}

export interface SyncSummary {
  downloaded: number
  uploaded: number
  deleted: number
  /** Files both PCs changed: the newer won and the other copy went to the backups. */
  conflicts: number
  /** Files left for a later pass (changed meanwhile, refused by the host). */
  skipped: number
  failed: number
  /** The paths (inside the Emulation folder) this pass changed here: downloaded or deleted. */
  changedHere: string[]
}

export interface SyncProgress {
  done: number
  total: number
}

export interface EmulationSync {
  host: {
    manifest(root: string, scope: SyncScope): Promise<EmulationManifest>
    /** The absolute path of a file the client may download, or null. */
    file(root: string, scope: SyncScope, path: string): Promise<string | null>
    uploadChunk(
      clientId: string,
      root: string,
      id: string,
      offset: number,
      total: number,
      data: Buffer
    ): Promise<void>
    commit(clientId: string, root: string, scope: SyncScope, commit: EmulationCommit): Promise<void>
    remove(
      clientId: string,
      root: string,
      scope: SyncScope,
      request: EmulationDelete
    ): Promise<void>
    /** A client was unpaired: its unfinished uploads go. */
    forgetClient(clientId: string, root: string): Promise<void>
  }
  /** One pass with one host. Throws when the pass cannot run (host unreachable, folder unreadable). */
  syncWithHost(options: {
    hostId: string
    transport: EmulationTransport
    root: string
    scope: SyncScope
    signal?: AbortSignal
    onProgress?: (p: SyncProgress) => void
  }): Promise<SyncSummary>
  /** A host was unpaired: what this PC remembered of it goes. */
  forgetHost(hostId: string): Promise<void>
}

const MAX_UPLOAD_BYTES = 256 * 1024 ** 3
/** Room left on the host's drive beyond the upload itself. */
const SPARE_BYTES = 256 * 1024 ** 2
const UPLOAD_ID = /^[A-Za-z0-9-]{8,64}$/
/**
 * Unfinished uploads one client may have staged on the host at a time. A client sends one file at a time, so more
 * than a few are uploads it gave up on (or a client misbehaving): starting another removes its oldest.
 */
export const MAX_CLIENT_UPLOADS = 4
/** Unfinished uploads older than this are removed. */
const STALE_UPLOAD_MS = 24 * 3_600_000
/** The base and hashes are written down at least this often during a pass (a stopped pass loses little). */
const SAVE_MS = 15_000
/** The host's staging folder for uploads, inside its Emulation folder (the name keeps it out of the sync). */
export const UPLOADS_FOLDER = 'uploads.playout-sync'
/** How long a finished host scan answers further requests (several clients at once). */
const MANIFEST_REUSE_MS = 5_000
/** Transfers failing one after another before a pass gives up (the host went away). */
const MAX_TRANSFER_FAILURES = 3

interface BaseFile {
  version: 1
  localRoot: string
  hostRoot: string
  /** The two folders' ids (FOLDER_ID_FILE) the base belongs to. */
  localId?: string
  hostId?: string
  files: Record<string, BaseEntry>
}

/** A file name for an id that came from elsewhere. */
const fileId = (id: string): string => createHash('sha1').update(id).digest('hex').slice(0, 24)

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const st = await fs.statfs(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return null
  }
}

/** The Emulation folder's id, made when it has none. The folder must exist. */
export async function folderId(root: string): Promise<string> {
  const file = join(root, FOLDER_ID_FILE)
  const have = (await fs.readFile(file, 'utf8').catch(() => '')).trim()
  if (/^[A-Za-z0-9-]{8,64}$/.test(have)) return have
  const id = randomUUID()
  await fs.writeFile(file, id)
  return id
}

/** One operation per file at a time, across the host and client roles of this PC. */
class KeyLock {
  private tails = new Map<string, Promise<void>>()

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((r) => (release = r))
    const tail = before.then(() => mine)
    this.tails.set(key, tail)
    await before
    try {
      return await work()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

async function statFile(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  const st = await fs.lstat(path).catch(() => null)
  return st?.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
}

const present = (path: string): Promise<boolean> =>
  fs.lstat(path).then(
    () => true,
    () => false
  )

/** The file is still what the scan saw (same size and modified time). */
async function unchanged(path: string, seen: SyncFile): Promise<boolean> {
  const st = await statFile(path)
  return !!st && st.size === seen.size && st.mtimeMs === seen.mtimeMs
}

/** Whether an error is the host refusing one file (as opposed to the connection failing). */
function hostRefusal(err: unknown): { status: number; code: string } | null {
  const e = err as { name?: string; status?: unknown; code?: unknown }
  return e?.name === 'HostRequestError' &&
    typeof e.status === 'number' &&
    typeof e.code === 'string'
    ? { status: e.status, code: e.code }
    : null
}

/**
 * A host-side file error (read-only, locked by an emulator or a scanner, a file where a folder should be) refuses
 * that one file: the client goes on with the others and tries it again next pass.
 */
async function asRefusal<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof SyncRefused) throw err
    const code = (err as NodeJS.ErrnoException).code
    if (typeof code === 'string' && code.startsWith('E'))
      throw new SyncRefused(409, 'host-file', (err as Error).message)
    throw err
  }
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(syncKey) : []

export function createEmulationSync(deps: EmulationSyncDeps): EmulationSync {
  const { log, stateDir } = deps
  const now = deps.now ?? Date.now
  const settleMs = deps.settleMs ?? 30_000
  const freeBytes = deps.freeBytes ?? defaultFreeBytes
  const lock = new KeyLock()
  const backups = new Backups(join(stateDir, 'backups'), now)
  const hostIndex = new HashIndex(join(stateDir, 'host-index.json'), now)
  const clientIndex = new HashIndex(join(stateDir, 'client-index.json'), now)
  const uploadsOf = (root: string, clientId: string): string =>
    join(root, UPLOADS_FOLDER, fileId(clientId))
  let lastBackupPrune = -Infinity
  const lastStagingPrune = new Map<string, number>()

  /** Old backups, and uploads a client never finished (in the host's folder, `root`). */
  const pruneSometimes = async (root?: string): Promise<void> => {
    if (now() - lastBackupPrune >= 3_600_000) {
      lastBackupPrune = now()
      await backups.prune()
    }
    if (!root) return
    const key = root.toLowerCase()
    if (now() - (lastStagingPrune.get(key) ?? -Infinity) < 3_600_000) return
    lastStagingPrune.set(key, now())
    const staging = join(root, UPLOADS_FOLDER)
    for (const client of await fs.readdir(staging).catch(() => [] as string[]))
      for (const name of await fs.readdir(join(staging, client)).catch(() => [] as string[])) {
        const file = join(staging, client, name)
        const st = await fs.stat(file).catch(() => null)
        if (st && now() - st.mtimeMs > STALE_UPLOAD_MS) await fs.rm(file, RM_RETRY).catch(() => {})
      }
  }

  // ---- host side ----

  /**
   * Keeps a client's unfinished uploads under MAX_CLIENT_UPLOADS, counting the one about to start: the oldest go.
   * Answers the ones that stay, newest first.
   */
  const dropOldUploads = async (dir: string, starting: string): Promise<string[]> => {
    const others: { file: string; mtimeMs: number }[] = []
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      if (name === starting) continue
      const file = join(dir, name)
      const st = await fs.stat(file).catch(() => null)
      if (st) others.push({ file, mtimeMs: st.mtimeMs })
    }
    others.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const old of others.slice(MAX_CLIENT_UPLOADS - 1))
      await fs.rm(old.file, RM_RETRY).catch(() => {})
    return others.slice(0, MAX_CLIENT_UPLOADS - 1).map((o) => o.file)
  }

  /** The scan in progress, or the last one while it is fresh (several clients asking together share it). */
  let manifestRun: {
    root: string
    doneAt: number | null
    promise: Promise<Omit<EmulationManifest, 'now'>>
  } | null = null

  const host: EmulationSync['host'] = {
    async manifest(root, scope) {
      const reuse =
        manifestRun &&
        manifestRun.root === root &&
        (manifestRun.doneAt === null || now() - manifestRun.doneAt < MANIFEST_REUSE_MS)
      if (!reuse) {
        const run: NonNullable<typeof manifestRun> = {
          root,
          doneAt: null,
          promise: (async () => {
            void pruneSometimes(root).catch(() => {})
            const scanned = await scanFolder(root, scope, hostIndex)
            return {
              root,
              folderId: await folderId(root),
              files: [...scanned.files.values()],
              unsettled: [...scanned.unsettled],
              linked: scanned.linked,
              excluded: scope.extraExcluded
            }
          })()
        }
        manifestRun = run
        run.promise.then(
          () => (run.doneAt = now()),
          () => {
            if (manifestRun === run) manifestRun = null
          }
        )
      }
      // The clock is read as the answer leaves (not when a shared scan started): the client compares it with its own.
      return { ...(await manifestRun!.promise), now: now() }
    },

    async file(root, scope, path) {
      const clean = cleanSyncPath(path, scope)
      if (!clean) return null
      const abs = absolutePath(root, clean)
      if (!(await statFile(abs)) || !(await realInside(root, clean))) return null
      return abs
    },

    uploadChunk: (clientId, root, id, offset, total, data) =>
      asRefusal(async () => {
        if (!UPLOAD_ID.test(id)) throw new SyncRefused(400, 'bad-request')
        if (!Number.isSafeInteger(total) || total < 0 || total > MAX_UPLOAD_BYTES)
          throw new SyncRefused(413, 'too-large')
        if (!Number.isSafeInteger(offset) || offset < 0 || offset + data.length > total)
          throw new SyncRefused(400, 'bad-offset')
        const dir = uploadsOf(root, clientId)
        const name = `${fileId(id)}.part`
        const part = join(dir, name)
        await fs.mkdir(dir, { recursive: true })
        /**
         * Room for the rest of the file, asked again with every piece (one cheap call per 512 KiB): the drive fills
         * from elsewhere during a long upload, and several uploads each fitted when they began.
         */
        const needRoom = async (): Promise<void> => {
          // The staging folder is on the Emulation folder's drive: the one that must hold the file.
          const free = await freeBytes(root)
          if (free !== null && free < total - offset + SPARE_BYTES)
            throw new SyncRefused(507, 'no-space', tMain('mainStreaming.emuSync.hostDriveFull'))
        }
        if (offset === 0) {
          /**
           * Before room is asked for: what this client left unfinished may be the very thing filling the drive. An
           * earlier try under this id goes first, then the uploads over the limit, and when that is still not
           * enough the client's other unfinished uploads, oldest first (it sends one file at a time, so at the
           * start of a new one the others were given up).
           */
          await fs.rm(part, RM_RETRY).catch(() => {})
          const kept = await dropOldUploads(dir, name)
          for (;;) {
            try {
              await needRoom()
              break
            } catch (err) {
              const oldest = kept.pop()
              if (!oldest || !(err instanceof SyncRefused)) throw err
              await fs.rm(oldest, RM_RETRY).catch(() => {})
            }
          }
          await fs.writeFile(part, data)
          return
        }
        const st = await statFile(part)
        if (!st || st.size !== offset) throw new SyncRefused(409, 'bad-offset')
        try {
          await needRoom()
        } catch (err) {
          // What was staged gives its room back: the client starts this file again at a later pass.
          await fs.rm(part, RM_RETRY).catch(() => {})
          throw err
        }
        await fs.appendFile(part, data)
      }),

    commit: (clientId, root, scope, c) =>
      asRefusal(async () => {
        const clean = cleanSyncPath(c.path, scope)
        if (!clean || !UPLOAD_ID.test(c.id) || !/^[0-9a-f]{40}$/.test(c.hash))
          throw new SyncRefused(400, 'bad-request')
        const part = join(uploadsOf(root, clientId), `${fileId(c.id)}.part`)
        try {
          const st = await statFile(part)
          if (!st || st.size !== c.size || (await sha1File(part)) !== c.hash)
            throw new SyncRefused(409, 'incomplete')
          const target = absolutePath(root, clean)
          await lock.run(syncKey(clean), async () => {
            if (!(await realInside(root, clean))) throw new SyncRefused(409, 'linked')
            const there = await fs.lstat(target).catch(() => null)
            if (there && !there.isFile()) throw new SyncRefused(409, 'changed')
            const current = there ? await sha1File(target) : null
            if (current !== c.expect) throw new SyncRefused(409, 'changed')
            if (there && c.backup) await backups.copy(target, clean, current!)
            await fs.mkdir(dirname(target), { recursive: true })
            // One step: the old copy stays whole until the new one takes its place.
            await renameRetry(part, target)
            const mtime = Math.min(c.mtimeMs, now())
            await fs.utimes(target, new Date(), new Date(mtime)).catch(() => {})
            const after = await statFile(target)
            if (after) {
              await hostIndex.use(root)
              hostIndex.set(syncKey(clean), after.size, after.mtimeMs, c.hash)
              await hostIndex.saveIfDue()
            }
          })
          manifestRun = null
        } finally {
          await fs.rm(part, RM_RETRY).catch(() => {})
        }
      }),

    remove: (clientId, root, scope, d) =>
      asRefusal(async () => {
        const clean = cleanSyncPath(d.path, scope)
        if (!clean || !/^[0-9a-f]{40}$/.test(d.expect)) throw new SyncRefused(400, 'bad-request')
        const target = absolutePath(root, clean)
        await lock.run(syncKey(clean), async () => {
          if (!(await statFile(target))) return
          if (!(await realInside(root, clean))) throw new SyncRefused(409, 'linked')
          if ((await sha1File(target)) !== d.expect) throw new SyncRefused(409, 'changed')
          await backups.keep(target, clean)
          log.info(`Emulation sync: ${clean} deleted (as on ${clientId.slice(0, 8)})`)
        })
        manifestRun = null
      }),

    async forgetClient(clientId, root) {
      await fs.rm(uploadsOf(root, clientId), RM_RETRY).catch(() => {})
    }
  }

  // ---- client side ----

  const baseFile = (hostId: string): string => join(stateDir, 'hosts', `${fileId(hostId)}.json`)

  async function loadBase(hostId: string): Promise<BaseFile | null> {
    try {
      const data = JSON.parse(await fs.readFile(baseFile(hostId), 'utf8')) as BaseFile
      return data.version === 1 && data.files ? data : null
    } catch {
      return null
    }
  }

  const syncWithHost: EmulationSync['syncWithHost'] = async (o) => {
    const { transport, root, scope, signal, hostId } = o
    void pruneSometimes().catch(() => {})
    const manifest = await transport.manifest(signal)
    // The host stamps its clock as the answer leaves; the answer is small next to a scan, so arrival is the moment.
    const skewMs = (Number.isFinite(manifest.now) ? manifest.now : now()) - now()
    const remote = new Map<string, SyncFile>()
    for (const f of Array.isArray(manifest.files) ? manifest.files : []) {
      const clean = cleanSyncPath(f?.path, scope)
      if (
        !clean ||
        !Number.isSafeInteger(f.size) ||
        f.size < 0 ||
        !Number.isFinite(f.mtimeMs) ||
        typeof f.hash !== 'string' ||
        !/^[0-9a-f]{40}$/.test(f.hash)
      )
        continue
      remote.set(syncKey(clean), { path: clean, size: f.size, mtimeMs: f.mtimeMs, hash: f.hash })
    }
    const scanned = await scanFolder(root, scope, clientIndex, signal)
    const local = scanned.files

    const localId = await folderId(root)
    const remoteId = typeof manifest.folderId === 'string' ? manifest.folderId : ''
    const stored = await loadBase(hostId)
    // Another folder on either side than the base was made with (moved, new, emptied, another drive): merge again
    // from scratch instead of reading the difference as deletions.
    const sameFolders =
      !!stored &&
      !!remoteId &&
      stored.localRoot.toLowerCase() === root.toLowerCase() &&
      stored.hostRoot.toLowerCase() === String(manifest.root).toLowerCase() &&
      stored.localId === localId &&
      stored.hostId === remoteId
    if (stored && !sameFolders && Object.keys(stored.files).length)
      log.info(`Emulation sync with ${hostId.slice(0, 8)}: a folder changed; merging both again`)
    const baseFiles = new Map(sameFolders ? Object.entries(stored!.files) : [])
    const base: BaseFile = {
      version: 1,
      localRoot: root,
      hostRoot: String(manifest.root),
      localId,
      hostId: remoteId,
      files: Object.fromEntries(baseFiles)
    }
    const hold = heldKeys({
      local,
      remote,
      localNow: now(),
      remoteNow: manifest.now,
      settleMs,
      unsettled: [...scanned.unsettled, ...strings(manifest.unsettled)]
    })
    const holdUnder = [
      ...scanned.linked,
      ...strings(manifest.linked),
      ...strings(manifest.excluded)
    ]
    const actions = planSync({ local, remote, base: baseFiles, hold, holdUnder, skewMs })
    const summary: SyncSummary = {
      downloaded: 0,
      uploaded: 0,
      deleted: 0,
      conflicts: 0,
      skipped: 0,
      failed: 0,
      changedHere: []
    }
    const work = actions.filter((a) => a.kind !== 'record')
    let done = 0
    o.onProgress?.({ done, total: work.length })
    let lastSave = now()
    const save = async (): Promise<void> => {
      lastSave = now()
      await writeJsonAtomic(baseFile(hostId), base)
      await clientIndex.save().catch(() => {})
    }

    const run = async (a: SyncAction): Promise<'done' | 'skipped'> => {
      switch (a.kind) {
        case 'record':
          if (a.entry) base.files[a.key] = a.entry
          else delete base.files[a.key]
          return 'done'
        case 'download': {
          const rel = a.local?.path ?? a.remote.path
          if (!(await realInside(root, rel))) return 'skipped' // a junction or link on the way here
          const dest = absolutePath(root, rel)
          const tmp = `${dest}.playout-sync`
          await fs.mkdir(dirname(dest), { recursive: true })
          try {
            await transport.download(a.remote.path, tmp, signal)
            if ((await sha1File(tmp)) !== a.remote.hash) return 'skipped' // the host's copy changed meanwhile
            return await lock.run(a.key, async () => {
              if (a.local ? !(await unchanged(dest, a.local)) : await present(dest))
                return 'skipped' // changed here meanwhile: the next pass decides again
              if (a.local && a.backupLocal) await backups.copy(dest, rel, a.local.hash)
              // One step: this PC's copy stays whole until the new one takes its place.
              await renameRetry(tmp, dest)
              const mtime = Math.min(a.remote.mtimeMs - skewMs, now())
              await fs.utimes(dest, new Date(), new Date(mtime)).catch(() => {})
              const st = await statFile(dest)
              if (st) clientIndex.set(a.key, st.size, st.mtimeMs, a.remote.hash)
              base.files[a.key] = { path: rel, hash: a.remote.hash }
              summary.downloaded++
              summary.changedHere.push(rel)
              if (a.backupLocal) summary.conflicts++
              return 'done'
            })
          } finally {
            await fs.rm(tmp, RM_RETRY).catch(() => {})
          }
        }
        case 'upload': {
          const src = absolutePath(root, a.local.path)
          const id = randomUUID()
          const hash = createHash('sha1')
          const fh = await fs.open(src, 'r')
          try {
            const buf = Buffer.alloc(Math.min(UPLOAD_CHUNK_BYTES, Math.max(1, a.local.size)))
            let offset = 0
            do {
              const { bytesRead } = await fh.read(
                buf,
                0,
                Math.min(buf.length, a.local.size - offset),
                offset
              )
              if (bytesRead === 0 && offset < a.local.size) return 'skipped' // shrank meanwhile
              const chunk = Buffer.from(buf.subarray(0, bytesRead))
              hash.update(chunk)
              await transport.uploadChunk(id, offset, a.local.size, chunk, signal)
              offset += bytesRead
            } while (offset < a.local.size)
          } finally {
            await fh.close()
          }
          const digest = hash.digest('hex')
          if (digest !== a.local.hash || !(await unchanged(src, a.local))) return 'skipped'
          await transport.commit(
            {
              id,
              path: a.local.path,
              size: a.local.size,
              hash: digest,
              mtimeMs: a.local.mtimeMs + skewMs,
              expect: a.expect,
              ...(a.backupRemote ? { backup: true } : {})
            },
            signal
          )
          base.files[a.key] = { path: a.local.path, hash: digest }
          summary.uploaded++
          if (a.backupRemote) summary.conflicts++
          return 'done'
        }
        case 'deleteLocal': {
          const file = absolutePath(root, a.local.path)
          return lock.run(a.key, async () => {
            if (!(await unchanged(file, a.local)) || !(await realInside(root, a.local.path)))
              return 'skipped'
            await backups.keep(file, a.local.path)
            delete base.files[a.key]
            summary.deleted++
            summary.changedHere.push(a.local.path)
            return 'done'
          })
        }
        case 'deleteRemote': {
          // Under the file's lock, like every other change: nothing on this PC (a download from another host, an
          // upload another client commits here) puts the file back between the check and the host's delete.
          return lock.run(a.key, async () => {
            // Still gone here? (It may have come back since the scan.)
            if (await present(absolutePath(root, a.remote.path))) return 'skipped'
            await transport.remove({ path: a.remote.path, expect: a.remote.hash }, signal)
            delete base.files[a.key]
            summary.deleted++
            return 'done'
          })
        }
      }
    }

    let transferFailures = 0
    try {
      for (const a of actions) {
        if (signal?.aborted) throw signal.reason ?? new Error('Cancelled')
        try {
          if ((await run(a)) === 'skipped') summary.skipped++
          transferFailures = 0
        } catch (err) {
          if (signal?.aborted) throw err
          const refusal = hostRefusal(err)
          if (refusal && [400, 404, 409, 413, 507].includes(refusal.status)) {
            // The host refused this one file (it changed there meanwhile, no room): the next pass decides again.
            summary.skipped++
            log.debug(`Emulation sync: ${a.key} not synced (${refusal.code})`)
          } else if (!refusal && typeof (err as NodeJS.ErrnoException).path === 'string') {
            // A file of this PC (locked, no permission): count it and go on.
            summary.failed++
            log.warn(`Emulation sync: ${a.key} failed: ${(err as Error).message}`)
          } else if (
            !refusal ||
            (refusal.status >= 500 && refusal.status !== 503) ||
            refusal.status === 429
          ) {
            // This file's transfer failed (a dropped connection, a stream cut short, the host busy reading it): the
            // others go on, this one is tried again next pass. Several in a row: the host is gone, the pass ends.
            if (
              ++transferFailures >= MAX_TRANSFER_FAILURES ||
              (err as Error).name === 'CertificateMismatchError'
            )
              throw err
            summary.failed++
            log.warn(`Emulation sync: ${a.key} not transferred: ${(err as Error).message}`)
          } else throw err // the host's sign-in, the sync turned off there, its folder unreadable: the pass ends
        }
        if (a.kind !== 'record') o.onProgress?.({ done: ++done, total: work.length })
        if (now() - lastSave >= SAVE_MS) await save()
      }
    } finally {
      await save().catch((err) => log.warn('Emulation sync: base not saved', err))
    }
    return summary
  }

  return {
    host,
    syncWithHost,
    async forgetHost(hostId) {
      await fs.rm(baseFile(hostId), RM_RETRY).catch(() => {})
    }
  }
}

export { scopeFor } from './rules'
export type {
  EmulationTransport,
  EmulationManifest,
  EmulationCommit,
  EmulationDelete
} from './types'
