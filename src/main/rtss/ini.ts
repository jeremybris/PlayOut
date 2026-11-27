/**
 * Minimal edits of an RTSS profile (an ini file: `[Section]` lines and `Key=Value` lines). The power helper's C#
 * (helper/csharp.ts, class PlayOutPower.RtssIni) does the same edits as SYSTEM; helper-csharp.test.ts compiles it and
 * compares the two on the same cases, so keep them in step.
 *
 * Every line PlayOut does not change is kept as it is, in its order, with the file's own line ending (CRLF for a
 * new file, as RTSS writes them).
 */

function splitLines(text: string): { lines: string[]; nl: string; trailing: boolean } {
  const nl = text.includes('\r\n') ? '\r\n' : text.includes('\n') ? '\n' : '\r\n'
  const trailing = text.length === 0 || text.endsWith('\n')
  const lines = text.length ? text.split('\n').map((l) => l.replace(/\r+$/, '')) : []
  if (lines.length && text.endsWith('\n')) lines.pop()
  return { lines, nl, trailing }
}

function isHeader(line: string): boolean {
  const t = line.trim()
  return t.length >= 2 && t.startsWith('[') && t.endsWith(']')
}

function isSection(line: string, section: string): boolean {
  return isHeader(line) && line.trim().slice(1, -1).trim().toLowerCase() === section.toLowerCase()
}

/** The key of a `Key=Value` line (trimmed), or null for headers, comments and other lines. */
function keyOf(line: string): string | null {
  const t = line.trim()
  if (!t || t.startsWith(';') || t.startsWith('#') || t.startsWith('[')) return null
  const eq = t.indexOf('=')
  return eq > 0 ? t.slice(0, eq).trim() : null
}

function sectionRange(lines: string[], section: string): [number, number] | null {
  const start = lines.findIndex((l) => isSection(l, section))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !isHeader(lines[end]!)) end++
  return [start, end]
}

/** A key's value in a section (text after '=', trimmed), or null when absent. The first one wins. */
export function getIniValue(text: string | null, section: string, key: string): string | null {
  if (!text) return null
  const { lines } = splitLines(text)
  const range = sectionRange(lines, section)
  if (!range) return null
  for (let i = range[0] + 1; i < range[1]; i++) {
    const line = lines[i]!
    if (keyOf(line)?.toLowerCase() === key.toLowerCase())
      return line.slice(line.indexOf('=') + 1).trim()
  }
  return null
}

/**
 * Set `key=value` in `[section]` (null removes every `key=` line of that section). A missing key goes after the
 * section's last non-blank line; a missing section is added at the end. Returns `text` itself when nothing changes.
 */
export function setIniValue(
  text: string | null,
  section: string,
  key: string,
  value: string | null
): string {
  const source = text ?? ''
  const { lines, nl, trailing } = splitLines(source)
  const range = sectionRange(lines, section)
  let changed = false
  if (!range) {
    if (value === null) return source
    lines.push(`[${section}]`, `${key}=${value}`)
    changed = true
  } else {
    const [start, end] = range
    const found: number[] = []
    for (let i = start + 1; i < end; i++)
      if (keyOf(lines[i]!)?.toLowerCase() === key.toLowerCase()) found.push(i)
    if (value === null) {
      for (const i of found.reverse()) lines.splice(i, 1)
      changed = found.length > 0
    } else if (found.length) {
      const i = found[0]!
      const next = `${keyOf(lines[i]!)}=${value}`
      if (lines[i] !== next) {
        lines[i] = next
        changed = true
      }
    } else {
      let at = end
      while (at - 1 > start && lines[at - 1]!.trim() === '') at--
      lines.splice(at, 0, `${key}=${value}`)
      changed = true
    }
  }
  if (!changed) return source
  return lines.join(nl) + (trailing ? nl : '')
}

/** Nothing but section headers and blank lines: a file PlayOut created that holds no setting any more. */
export function iniIsEmpty(text: string | null): boolean {
  if (!text) return true
  return splitLines(text).lines.every((l) => l.trim() === '' || isHeader(l))
}
