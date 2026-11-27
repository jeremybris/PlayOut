// Small pieces both save copies in the Emulation folder use: the recompilations' (src/main/recomp/service.ts, copies in
// "Recompilations Saves") and the PC games' (src/main/pc-saves/service.ts, copies in "PC Saves"). The copying itself
// (three-way hashes, backups, all-or-nothing restores) is src/main/recomp/cloud.ts, shared by both.
import { randomUUID } from 'crypto'
import { promises as fs, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/** The file in PlayOut's data folder holding this install's own id (machineIdOf). */
export const MACHINE_ID_FILE = 'save-copy-machine-id'

/**
 * This PlayOut install's own random id, made once and kept in <userData>/save-copy-machine-id: written into each
 * copy's meta.json so "this PC's own copy" never mistakes another PC with the same computer name for this one. Read
 * synchronously (a few bytes, once per service); when it cannot be stored, a fresh id serves this run.
 */
export function machineIdOf(userData: string): string {
  const file = join(userData, MACHINE_ID_FILE)
  try {
    const id = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f-]{16,64}$/i.test(id)) return id
  } catch {
    // made below
  }
  const id = randomUUID()
  try {
    mkdirSync(userData, { recursive: true })
    writeFileSync(file, id)
  } catch {
    // this run only
  }
  return id
}

/**
 * Jobs run one at a time per key (one game's or recompilation's syncs never overlap); different keys run side by side.
 * A failed job does not stop the next one.
 */
export function createKeyedLock(): <T>(key: string, job: () => Promise<T>) => Promise<T> {
  const locks = new Map<string, Promise<unknown>>()
  return function withLock<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve()
    const run = prev.then(job, job)
    const tail = run.catch(() => undefined)
    locks.set(key, tail)
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key)
    })
    return run
  }
}

/** A promise answered within `ms`, else `fallback` (a disconnected network or USB drive can take long to answer). */
async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<T>((ok) => {
    timer = setTimeout(() => ok(fallback), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The folder names in `dir`, read once with a time limit: [] when it does not exist yet, null when it cannot be read
 * (or not in time).
 */
export function folderNamesWithin(dir: string, ms: number): Promise<string[] | null> {
  const read = fs.readdir(dir, { withFileTypes: true }).then(
    (ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name),
    (err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? [] : null)
  )
  return within(read, ms, null)
}

/** Whether a file or folder is there, answered within `ms` (false when it takes longer). */
export function pathThereWithin(p: string, ms: number): Promise<boolean> {
  const check = fs.stat(p).then(
    () => true,
    () => false
  )
  return within(check, ms, false)
}
