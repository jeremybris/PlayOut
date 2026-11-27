// A ReXGlue recompilation's own achievement metadata, when it ships one: achievements.toml, an [[achievements]] table
// per achievement (id, label, description, unachieved_description, gamerscore, flags). The runtime lays it over the
// table in the game's executable: an entry replaces the one with the same id, or is added (mergeAchievements). Where it
// is looked for follows the runtime's own lookup beside the game's data folder (ReXGlue, BSD-3-Clause:
// title_state.cpp FindMetadataPath): <root>\metadata, <root's parent>\metadata, then <root> itself.
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { XdbfAchievement } from './xdbf'

/** An achievements.toml bigger than this is not read (a real one is a few kilobytes). */
export const MAX_TOML = 4 * 1024 * 1024

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  '"': '"',
  '\\': '\\'
}

/** A basic string's escapes. */
function unescape(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e: string) => {
    if (e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16))
    return ESCAPES[e] ?? e
  })
}

/** A TOML string or integer value on one line; null for anything else. */
function value(text: string): string | number | null {
  const s = text.trim()
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(s)
    return m ? unescape(m[1]!) : null
  }
  if (s.startsWith("'")) {
    const m = /^'([^']*)'/.exec(s)
    return m ? m[1]! : null
  }
  const n = s.replace(/\s*#.*$/, '').replace(/_/g, '')
  if (/^[+-]?[0-9]+$/.test(n)) return Number(n)
  if (/^0x[0-9a-f]+$/i.test(n)) return Number.parseInt(n.slice(2), 16)
  return null
}

/**
 * A multi-line string ("""...""" or '''...''') starting at `lines[i]` after `key =`: its value and the index of its
 * last line; null when it is not one or never closes.
 */
function multiline(first: string, lines: string[], i: number): { v: string; end: number } | null {
  const quote = first.startsWith('"""') ? '"""' : first.startsWith("'''") ? "'''" : null
  if (!quote) return null
  // The text after the opening quotes, then whole lines, up to the closing quotes.
  let body = first.slice(3)
  let end = i
  for (;;) {
    const close = body.indexOf(quote, body.lastIndexOf('\n') + 1)
    if (close >= 0) {
      body = body.slice(0, close)
      break
    }
    if (++end >= lines.length) return null
    body += `\n${lines[end]!.replace(/\r$/, '')}`
  }
  // A newline right after the opening quotes is not part of the string.
  if (body.startsWith('\n')) body = body.slice(1)
  if (quote === "'''") return { v: body, end }
  // A backslash at a line's end joins the next line, without the whitespace that starts it.
  return { v: unescape(body.replace(/\\[ \t]*\n\s*/g, '')), end }
}

/** The achievements in an achievements.toml; null when it has none. */
export function parseAchievementsToml(text: string): XdbfAchievement[] | null {
  const out: XdbfAchievement[] = []
  let cur: Record<string, string | number> | null = null
  const flush = (): void => {
    if (!cur) return
    const id = typeof cur.id === 'number' ? cur.id : 0
    if (id > 0 && !out.some((a) => a.id === id)) {
      const str = (k: string): string => (typeof cur![k] === 'string' ? (cur![k] as string) : '')
      const num = (k: string): number => (typeof cur![k] === 'number' ? (cur![k] as number) : 0)
      out.push({
        id,
        name: str('label'),
        description: str('description'),
        unachieved: str('unachieved_description'),
        gamerscore: num('gamerscore'),
        flags: num('flags')
      })
    }
    cur = null
  }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '').trim()
    if (!line || line.startsWith('#')) continue
    if (/^\[\[\s*achievements\s*\]\]/.test(line)) {
      flush()
      cur = {}
      continue
    }
    if (line.startsWith('[')) {
      flush()
      continue
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!kv) continue
    const long = multiline(kv[2]!, lines, i)
    if (long) {
      i = long.end
      if (cur) cur[kv[1]!] = long.v
      continue
    }
    if (!cur) continue
    const v = value(kv[2]!)
    if (v !== null) cur[kv[1]!] = v
  }
  flush()
  return out.length ? out : null
}

/**
 * The game's list with a recompilation's own entries laid over it, as the runtime does: an entry replaces the one with
 * the same id, or is added at the end.
 */
export function mergeAchievements(
  base: readonly XdbfAchievement[],
  overlay: readonly XdbfAchievement[]
): XdbfAchievement[] {
  const out = [...base]
  for (const a of overlay) {
    const at = out.findIndex((b) => b.id === a.id)
    if (at >= 0) out[at] = a
    else out.push(a)
  }
  return out
}

/** A folder the game's data may be in; `parent` false: its parent is not looked in (it is shared with other games). */
export interface MetadataRoot {
  dir: string
  parent: boolean
}

async function isFile(path: string): Promise<boolean> {
  return (await fs.stat(path).catch(() => null))?.isFile() ?? false
}

/**
 * The achievements.toml for a game whose data may be in `roots` (in order): <root>\metadata, <root's parent>\metadata
 * (when allowed), then <root>. Null when there is none.
 */
export async function findAchievementsToml(roots: readonly MetadataRoot[]): Promise<string | null> {
  const seen = new Set<string>()
  for (const root of roots) {
    const candidates = [
      join(root.dir, 'metadata', 'achievements.toml'),
      ...(root.parent ? [join(dirname(root.dir), 'metadata', 'achievements.toml')] : []),
      join(root.dir, 'achievements.toml')
    ]
    for (const path of candidates) {
      const key = path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      if (await isFile(path)) return path
    }
  }
  return null
}

/** Read and parse an achievements.toml; null when it cannot be read, is too big or has no achievements. */
export async function readAchievementsToml(path: string): Promise<XdbfAchievement[] | null> {
  const info = await fs.stat(path).catch(() => null)
  if (!info?.isFile() || info.size > MAX_TOML) return null
  const text = await fs.readFile(path, 'utf8').catch(() => null)
  return text === null ? null : parseAchievementsToml(text)
}
