// The unlock file a ReXGlue-built Xbox 360 recompilation keeps itself, read the way the runtime writes and reads it
// (ReXGlue, BSD-3-Clause: achievement_manager.cpp): <user_root>\achievements\<TITLE ID>.toml, one
// [unlocked.<decimal id>] table per unlocked achievement holding the Windows FILETIME it was unlocked at, or (older
// files, which the runtime migrates) one `unlocked = [ids]` list without times. PlayOut only reads it.
// user_root is each recompilation's own setting, so the file is looked for: under the folder the catalog names as the
// game's user data, under the recompilation's save folders, then as any achievements\<TITLE ID>.toml below its install
// folder or the user's usual data folders.
import { promises as fs, type Dirent } from 'node:fs'
import { join } from 'node:path'

/** Unlocked achievement id -> when (ISO time), or null when the file does not say. */
export type Unlocks = Map<number, string | null>

/** An unlock file bigger than this is not read (a real one is a few kilobytes). */
export const MAX_UNLOCK_FILE = 1024 * 1024

/** 100 ns intervals between 1601-01-01 (FILETIME's start) and 1970-01-01, in milliseconds. */
const FILETIME_EPOCH_MS = 11_644_473_600_000n
/** Times after this are not real (a corrupt value). */
const LATEST_MS = Date.UTC(3000, 0, 1)

/** A Windows FILETIME (100 ns intervals since 1601) as an ISO time; null for 0 or an impossible value. */
export function filetimeToIso(filetime: bigint): string | null {
  if (filetime <= 0n) return null
  const ms = filetime / 10_000n - FILETIME_EPOCH_MS
  if (ms <= 0n || ms > BigInt(LATEST_MS)) return null
  return new Date(Number(ms)).toISOString()
}

/** A TOML integer value (decimal or 0x hex, underscores allowed) as a bigint, else null. */
function tomlInt(text: string): bigint | null {
  const s = text.trim().replace(/_/g, '')
  if (/^\+?[0-9]+$/.test(s)) return BigInt(s.replace('+', ''))
  if (/^0x[0-9a-f]+$/i.test(s)) return BigInt(s)
  return null
}

/** A usable achievement id (1 to 2^32 - 1); null otherwise. */
function idFrom(n: bigint | null): number | null {
  return n !== null && n > 0n && n <= 0xffffffffn ? Number(n) : null
}

/** An [unlocked.<id>] key: a decimal id, as the runtime writes and reads it; null otherwise. */
function keyId(key: string): number | null {
  const k = key.trim()
  return /^[0-9]+$/.test(k) ? idFrom(BigInt(k)) : null
}

/** A line without its comment (a # outside quotes). */
function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#') return line.slice(0, i)
  }
  return line
}

/**
 * The unlocks in an unlock file's text. Anything it does not understand is skipped (a broken line, a zero or
 * non-decimal id, a missing or impossible time), so a damaged file still gives what it can.
 */
export function parseUnlockFile(text: string): Unlocks {
  const out: Unlocks = new Map()
  const add = (id: number | null, filetime: bigint | null): void => {
    if (id === null) return
    const iso = filetime !== null ? filetimeToIso(filetime) : null
    if (!out.has(id) || (iso && !out.get(id))) out.set(id, iso)
  }
  /** The [unlocked.<id>] table the lines belong to, or null for any other. */
  let current: number | null = null
  /** An `unlocked = [` list still open across lines. */
  let list: string | null = null
  /** Whether a table header has been seen (the older list is a top-level key). */
  let inTable = false
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim()
    if (list !== null) {
      list += ` ${line}`
      if (line.includes(']')) {
        readList(list)
        list = null
      }
      continue
    }
    if (!line) continue
    if (line.startsWith('[')) {
      inTable = true
      const header = /^\[\s*unlocked\s*\.\s*([^\]]+?)\s*\]$/.exec(line)
      current = header ? keyId(header[1]!) : null
      if (current !== null) add(current, null)
      continue
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]!.trim()
    const value = kv[2]!.trim()
    if (current !== null) {
      if (key === 'filetime') add(current, tomlInt(value))
    } else if (!inTable && key === 'unlocked' && value.startsWith('[')) {
      if (value.includes(']')) readList(value)
      else list = value
    }
  }
  function readList(value: string): void {
    const inner = value.slice(value.indexOf('[') + 1, value.indexOf(']'))
    for (const item of inner.split(',')) {
      if (!item.trim()) continue
      add(idFrom(tomlInt(item)), null)
    }
  }
  return out
}

/** Where to look for a recompilation's unlock file. */
export interface UnlockLookup {
  /** The game's title id (8 hex digits, upper case): the file is named after it. */
  titleId: string | null
  /** The game's user data folder the catalog names (expanded, already checked as a safe place to look). */
  catalogFolder: string | null
  /** The recompilation's save folders (expanded). */
  saveFolders: string[]
  install: string
  /** User folders searched two levels down (AppData, Saved Games, Documents...). */
  roots: string[]
}

/** The install folder is searched this deep, the user folders `ROOT_DEPTH` deep, at most `MAX_DIRS` folders each. */
const INSTALL_DEPTH = 3
const ROOT_DEPTH = 2
const MAX_DIRS = 4000
const HEX_TOML = /^[0-9a-f]{8}\.toml$/i

async function isFile(path: string): Promise<boolean> {
  return (await fs.stat(path).catch(() => null))?.isFile() ?? false
}

async function dirents(dir: string): Promise<Dirent[]> {
  return fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[])
}

/** The one unlock file in `<userRoot>\achievements` when there is exactly one; else null. */
async function loneFile(userRoot: string): Promise<string | null> {
  const dir = join(userRoot, 'achievements')
  const files = (await dirents(dir)).filter((e) => e.isFile() && HEX_TOML.test(e.name))
  return files.length === 1 ? join(dir, files[0]!.name) : null
}

/** An `achievements\<file>` under `root`, at most `depth` folders down (breadth first). */
async function searchDown(root: string, file: string, depth: number): Promise<string | null> {
  let level = [root]
  let visited = 0
  for (let d = 0; d <= depth && level.length; d++) {
    const next: string[] = []
    for (const dir of level) {
      if (++visited > MAX_DIRS) return null
      for (const e of await dirents(dir)) {
        if (!e.isDirectory()) continue
        const sub = join(dir, e.name)
        if (e.name.toLowerCase() === 'achievements' && (await isFile(join(sub, file))))
          return join(sub, file)
        next.push(sub)
      }
    }
    level = next
  }
  return null
}

/**
 * Find a recompilation's unlock file, <user_root>\achievements\<TITLE ID>.toml: with the catalog's folder or a save
 * folder as user_root, else the first one below its install folder, then below the user folders. Without a title id,
 * only a lone unlock file under the catalog's folder. Null when there is none (yet: it appears after the first unlock).
 */
export async function locateUnlockFile(l: UnlockLookup): Promise<string | null> {
  if (!l.titleId) return l.catalogFolder ? loneFile(l.catalogFolder) : null
  const file = `${l.titleId}.toml`
  for (const userRoot of [...(l.catalogFolder ? [l.catalogFolder] : []), ...l.saveFolders]) {
    const path = join(userRoot, 'achievements', file)
    if (await isFile(path)) return path
  }
  const inInstall = await searchDown(l.install, file, INSTALL_DEPTH)
  if (inInstall) return inInstall
  for (const root of l.roots) {
    const hit = await searchDown(root, file, ROOT_DEPTH)
    if (hit) return hit
  }
  return null
}

/** Read and parse an unlock file; null when it cannot be read or is too big to be one. */
export async function readUnlockFile(path: string): Promise<Unlocks | null> {
  const info = await fs.stat(path).catch(() => null)
  if (!info?.isFile() || info.size > MAX_UNLOCK_FILE) return null
  const text = await fs.readFile(path, 'utf8').catch(() => null)
  return text === null ? null : parseUnlockFile(text)
}
