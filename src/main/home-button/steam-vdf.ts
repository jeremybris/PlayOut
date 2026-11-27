/**
 * Text edits on Valve's KeyValues files (config.vdf, localconfig.vdf) that change one key and leave every other byte
 * as Steam wrote it. Parsing to an object and printing it again would reorder, re-quote and re-indent a 300 KB
 * file that Steam owns; a token-level edit only touches the value it means to.
 *
 * Keys compare without case, as Steam does. Conditionals (`"key" "value" [$WIN32]`) and `//` comments are skipped.
 */

interface Token {
  kind: 'str' | 'open' | 'close' | 'cond'
  /** The unescaped text (strings). */
  text: string
  start: number
  end: number
}

function unescape(raw: string): string {
  return raw.replace(/\\(.)/g, (_, c: string) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c
  )
}

function escape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch.charCodeAt(0) === 0xfeff) {
      i++
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
    } else if (ch === '{' || ch === '}') {
      tokens.push({ kind: ch === '{' ? 'open' : 'close', text: ch, start: i, end: i + 1 })
      i++
    } else if (ch === '"') {
      const start = i
      i++
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      if (i >= n) throw new SyntaxError('VDF: unterminated quoted string')
      i++
      tokens.push({ kind: 'str', text: unescape(text.slice(start + 1, i - 1)), start, end: i })
    } else if (ch === '[') {
      const start = i
      while (i < n && text[i] !== ']' && text[i] !== '\n') i++
      if (text[i] === ']') i++
      tokens.push({ kind: 'cond', text: text.slice(start, i), start, end: i })
    } else {
      const start = i
      while (i < n && !/[\s{}"]/.test(text[i])) i++
      tokens.push({ kind: 'str', text: text.slice(start, i), start, end: i })
    }
  }
  return tokens
}

export interface VdfEntry {
  /** The blocks it is in, outermost first (as written). */
  path: string[]
  key: string
  value: string
  keyStart: number
  valueStart: number
  valueEnd: number
}

interface VdfBlock {
  path: string[]
  /** Just after its `{`. */
  openEnd: number
}

function scan(text: string): { entries: VdfEntry[]; blocks: VdfBlock[] } {
  const tokens = tokenize(text).filter((t) => t.kind !== 'cond')
  const entries: VdfEntry[] = []
  const blocks: VdfBlock[] = []
  const stack: string[] = []
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (t.kind === 'close') {
      if (stack.length === 0) throw new SyntaxError('VDF: unbalanced }')
      stack.pop()
      i++
      continue
    }
    if (t.kind !== 'str') throw new SyntaxError(`VDF: unexpected ${t.text} at ${t.start}`)
    const next = tokens[i + 1]
    if (!next) throw new SyntaxError('VDF: key without a value at the end')
    if (next.kind === 'open') {
      stack.push(t.text)
      blocks.push({ path: [...stack], openEnd: next.end })
      i += 2
    } else if (next.kind === 'str') {
      entries.push({
        path: [...stack],
        key: t.text,
        value: next.text,
        keyStart: t.start,
        valueStart: next.start,
        valueEnd: next.end
      })
      i += 2
    } else {
      throw new SyntaxError(`VDF: unexpected } after key ${t.text}`)
    }
  }
  if (stack.length !== 0) throw new SyntaxError('VDF: unclosed block')
  return { entries, blocks }
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Every occurrence of `key`, anywhere in the file. Throws SyntaxError on a file that is not KeyValues. */
export function findVdfKey(text: string, key: string): VdfEntry[] {
  return scan(text).entries.filter((e) => same(e.key, key))
}

/** The file's line ending: CRLF when it has any, else LF. */
export function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

export interface VdfSetResult {
  text: string
  changed: boolean
  /** The first occurrence's value before the edit, or null when the key was absent. */
  previous: string | null
}

/**
 * Set `key` to `value` everywhere it occurs. When it occurs nowhere, add it to the block at `insertPath` (compared
 * without case; missing blocks along the path are created), Steam's way: own line, tab indent, two tabs between.
 */
export function setVdfKey(
  text: string,
  key: string,
  value: string,
  insertPath: readonly string[]
): VdfSetResult {
  return setWhere(text, key, value, insertPath, () => true)
}

/**
 * Set `key` only where it sits directly in the block at `blockPath` (compared without case; the same key in other
 * blocks is left alone). When that block has no such key, it is added there (missing blocks along the path created).
 */
export function setVdfKeyAt(
  text: string,
  blockPath: readonly string[],
  key: string,
  value: string
): VdfSetResult {
  return setWhere(text, key, value, blockPath, (e) => samePath(e.path, blockPath))
}

/** The entries of `key` sitting directly in the block at `blockPath` (compared without case). */
export function findVdfKeyAt(text: string, blockPath: readonly string[], key: string): VdfEntry[] {
  return findVdfKey(text, key).filter((e) => samePath(e.path, blockPath))
}

function samePath(path: readonly string[], want: readonly string[]): boolean {
  return path.length === want.length && path.every((p, i) => same(p, want[i]))
}

function setWhere(
  text: string,
  key: string,
  value: string,
  insertPath: readonly string[],
  where: (e: VdfEntry) => boolean
): VdfSetResult {
  const { entries, blocks } = scan(text)
  const hits = entries.filter((e) => same(e.key, key) && where(e))
  const quoted = `"${escape(value)}"`
  if (hits.length > 0) {
    let out = text
    let changed = false
    for (const e of [...hits].reverse()) {
      if (e.value === value && out.slice(e.valueStart, e.valueEnd) === quoted) continue
      out = out.slice(0, e.valueStart) + quoted + out.slice(e.valueEnd)
      changed = true
    }
    return { text: out, changed, previous: hits[0].value }
  }

  if (insertPath.length === 0) throw new Error('VDF: no block to add the key to')
  const eol = detectEol(text)
  // The deepest block along insertPath that exists.
  let depth = 0
  let parent: VdfBlock | undefined
  for (let d = insertPath.length; d >= 1 && !parent; d--) {
    parent = blocks.find(
      (b) => b.path.length === d && b.path.every((p, i) => same(p, insertPath[i]))
    )
    if (parent) depth = d
  }
  if (!parent) throw new Error(`VDF: block "${insertPath[0]}" not found`)

  const tabs = (n: number): string => '\t'.repeat(n)
  const line = `${tabs(insertPath.length)}"${escape(key)}"\t\t${quoted}`
  // Build from the inside out: the key line wrapped in each missing block.
  let inner = eol + line
  for (let d = insertPath.length - 1; d >= depth; d--) {
    inner = `${eol}${tabs(d)}"${escape(insertPath[d])}"${eol}${tabs(d)}{${inner}${eol}${tabs(d)}}`
  }
  const out = text.slice(0, parent.openEnd) + inner + text.slice(parent.openEnd)
  return { text: out, changed: true, previous: null }
}

/** Remove every occurrence of `key` (its whole line when it is alone on it). */
export function removeVdfKey(text: string, key: string): { text: string; changed: boolean } {
  return removeEntries(text, findVdfKey(text, key))
}

/** Remove `key` only where it sits directly in the block at `blockPath` (compared without case). */
export function removeVdfKeyAt(
  text: string,
  blockPath: readonly string[],
  key: string
): { text: string; changed: boolean } {
  return removeEntries(
    text,
    findVdfKey(text, key).filter((e) => samePath(e.path, blockPath))
  )
}

function removeEntries(text: string, hits: VdfEntry[]): { text: string; changed: boolean } {
  let out = text
  for (const e of [...hits].reverse()) {
    let start = e.keyStart
    let end = e.valueEnd
    // A trailing conditional belongs to the entry.
    const cond = /^[ \t]*\[[^\]\n]*\]/.exec(out.slice(end))
    if (cond) end += cond[0].length
    const lineStart = out.lastIndexOf('\n', start - 1) + 1
    const lineEndMatch = /^[ \t]*(\r?\n|$)/.exec(out.slice(end))
    if (/^[ \t]*$/.test(out.slice(lineStart, start)) && lineEndMatch) {
      start = lineStart
      end += lineEndMatch[0].length
    }
    out = out.slice(0, start) + out.slice(end)
  }
  return { text: out, changed: hits.length > 0 }
}

// --- bytes ---------------------------------------------------------------------------------------------------------

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** Steam writes UTF-8, with or without a BOM; the BOM is kept apart so it goes back exactly as it was. */
export function decodeVdf(data: Buffer): { text: string; bom: boolean } {
  const bom = data.length >= 3 && data.subarray(0, 3).equals(BOM)
  return { text: (bom ? data.subarray(3) : data).toString('utf8'), bom }
}

export function encodeVdf(text: string, bom: boolean): Buffer {
  const body = Buffer.from(text, 'utf8')
  return bom ? Buffer.concat([BOM, body]) : body
}
