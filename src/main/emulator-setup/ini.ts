import { promises as fs } from 'fs'
import { dirname } from 'path'

/**
 * Line-based config editors for the emulator setup (docs/emulator-setup.md, "Config helpers"). Each one changes only
 * the lines of the keys it is given, keeps every other line (comments included) as it was, keeps the file's line
 * endings, and writes UTF-8 without a BOM. A file that is not changed is not rewritten. The INI editors take an
 * `encoding` option: 'latin1' maps every byte to one character and back, so an ANSI file (Model 2's EMULATOR.INI)
 * keeps its non-ASCII bytes through a round trip.
 */

/** How a file's bytes are read and written: UTF-8 (the default), or byte-preserving 'latin1' for ANSI files. */
export type TextEncoding = 'utf8' | 'latin1'

interface TextFile {
  lines: string[]
  eol: string
  /** Whether the text ends with a line break (kept as found; new files get one). */
  finalEol: boolean
  original: string | null
}

async function readText(
  file: string,
  newEol: string,
  encoding: TextEncoding = 'utf8'
): Promise<TextFile> {
  let text: string
  try {
    text = await fs.readFile(file, encoding)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return { lines: [], eol: newEol, finalEol: true, original: null }
  }
  const original = text
  if (encoding === 'utf8' && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const eol = text.includes('\r\n') ? '\r\n' : text.includes('\n') ? '\n' : newEol
  if (text === '') return { lines: [], eol, finalEol: true, original }
  const finalEol = /\r?\n$/.test(text)
  const lines = (finalEol ? text.replace(/\r?\n$/, '') : text).split(/\r?\n/)
  return { lines, eol, finalEol, original }
}

async function writeText(
  file: string,
  f: TextFile,
  encoding: TextEncoding = 'utf8'
): Promise<void> {
  const text = f.lines.length === 0 ? '' : f.lines.join(f.eol) + (f.finalEol ? f.eol : '')
  if (text === f.original) return
  await fs.mkdir(dirname(file), { recursive: true })
  await fs.writeFile(file, text, encoding)
}

/** Index after the last non-blank line in [start, end), or `start` when all are blank. */
function insertionPoint(lines: string[], start: number, end: number): number {
  for (let i = end - 1; i >= start; i--) if (lines[i].trim() !== '') return i + 1
  return start
}

/** Appends a block at the end of the file, separated from earlier content by a blank line. */
function appendBlock(lines: string[], block: string[]): void {
  if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('')
  lines.push(...block)
}

const INI_SECTION = /^\s*\[([^\]]*)\]\s*$/

/**
 * Sets `key = value` lines (`style` 'spaced', the default) or `key=value` lines ('tight') under `[section]` of an INI
 * file, creating the file and the section when missing.
 * - Section names compare case-insensitively; the first matching section is used.
 * - Keys compare case-insensitively against uncommented lines (comments start with ';' or '#'); the first match is
 *   replaced, keeping the file's spelling of the key. A commented `;key=` line is left alone.
 * - A missing key is added after the last non-blank line of its section.
 * - New files use CRLF.
 * - `encoding` 'latin1' keeps the bytes of an ANSI file as they are (default 'utf8').
 */
export async function setIniValues(
  file: string,
  section: string,
  values: Record<string, string>,
  options?: { style?: 'spaced' | 'tight'; encoding?: TextEncoding }
): Promise<void> {
  const sep = options?.style === 'tight' ? '=' : ' = '
  const f = await readText(file, '\r\n', options?.encoding)
  const lines = f.lines
  const wanted = section.trim().toLowerCase()

  const range = (): { start: number; end: number } | null => {
    for (let i = 0; i < lines.length; i++) {
      const m = INI_SECTION.exec(lines[i])
      if (!m || m[1].trim().toLowerCase() !== wanted) continue
      let end = i + 1
      while (end < lines.length && !INI_SECTION.test(lines[end])) end++
      return { start: i + 1, end }
    }
    return null
  }

  const missing: string[] = []
  for (const [key, value] of Object.entries(values)) {
    const r = range()
    if (!r) {
      missing.push(`${key}${sep}${value}`)
      continue
    }
    let done = false
    for (let i = r.start; i < r.end; i++) {
      const line = lines[i]
      const t = line.trimStart()
      if (t.startsWith(';') || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq < 0) continue
      const name = t.slice(0, eq).trim()
      if (name.toLowerCase() !== key.toLowerCase()) continue
      lines[i] = `${line.slice(0, line.length - t.length)}${name}${sep}${value}`
      done = true
      break
    }
    if (!done) lines.splice(insertionPoint(lines, r.start, r.end), 0, `${key}${sep}${value}`)
  }
  if (missing.length > 0) appendBlock(lines, [`[${section}]`, ...missing])
  await writeText(file, f, options?.encoding)
}

const TOML_TABLE = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/
const TOML_ANY_TABLE = /^\s*\[/

/** A TOML basic string: `"..."` with backslashes, quotes and control characters escaped. */
function tomlString(value: string): string {
  // eslint-disable-next-line no-control-regex -- TOML requires control characters to be escaped
  const escaped = value.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => {
    if (c === '\\') return '\\\\'
    if (c === '"') return '\\"'
    if (c === '\n') return '\\n'
    if (c === '\r') return '\\r'
    if (c === '\t') return '\\t'
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
  return `"${escaped}"`
}

/** The bare or quoted key of a `key = value` TOML line, or null. */
function tomlKey(line: string): string | null {
  const m = /^\s*([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')\s*=/.exec(line)
  if (!m) return null
  const k = m[1]
  return k.startsWith('"') || k.startsWith("'") ? k.slice(1, -1) : k
}

/**
 * Sets string keys in a TOML file: `key = "value"` in `[table]`, or at the root (before the first table header) when
 * `table` is null. Table and key names compare exactly (TOML is case-sensitive). New files use LF.
 */
export async function setTomlValues(
  file: string,
  table: string | null,
  values: Record<string, string>
): Promise<void> {
  const f = await readText(file, '\n')
  const lines = f.lines

  const range = (): { start: number; end: number } | null => {
    if (table === null) {
      let end = 0
      while (end < lines.length && !TOML_ANY_TABLE.test(lines[end])) end++
      return { start: 0, end }
    }
    for (let i = 0; i < lines.length; i++) {
      const m = TOML_TABLE.exec(lines[i])
      if (!m || m[1].trim() !== table) continue
      let end = i + 1
      while (end < lines.length && !TOML_ANY_TABLE.test(lines[end])) end++
      return { start: i + 1, end }
    }
    return null
  }

  const missing: string[] = []
  for (const [key, value] of Object.entries(values)) {
    const line = `${key} = ${tomlString(value)}`
    const r = range()
    if (!r) {
      missing.push(line)
      continue
    }
    let done = false
    for (let i = r.start; i < r.end; i++) {
      if (tomlKey(lines[i]) !== key) continue
      lines[i] = line
      done = true
      break
    }
    if (!done) lines.splice(insertionPoint(lines, r.start, r.end), 0, line)
  }
  if (missing.length > 0) appendBlock(lines, [`[${table}]`, ...missing])
  await writeText(file, f)
}

/** A YAML scalar: plain when safe, otherwise single-quoted. */
function yamlScalar(value: string): string {
  const plainSafe =
    value !== '' &&
    value === value.trim() &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !value.includes(': ') &&
    !value.includes(' #') &&
    !value.endsWith(':')
  return plainSafe ? value : `'${value.replace(/'/g, "''")}'`
}

/**
 * Sets top-level `key: value` lines of a YAML file (keys may contain slashes, like RPCS3's `/dev_hdd0/`). Only lines
 * that start at column 0 with the literal key followed by ':' are matched; every other line is kept. Missing keys are
 * appended. New files use LF.
 */
export async function setYamlTopLevel(file: string, values: Record<string, string>): Promise<void> {
  const f = await readText(file, '\n')
  const lines = f.lines
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}: ${yamlScalar(value)}`
    const i = lines.findIndex((l) => {
      if (!l.startsWith(`${key}:`)) return false
      const rest = l.slice(key.length + 1)
      return rest === '' || /^\s/.test(rest)
    })
    if (i >= 0) lines[i] = line
    else lines.splice(insertionPoint(lines, 0, lines.length), 0, line)
  }
  await writeText(file, f)
}

/** MAME's option name column: names are padded to 26 columns. */
const MAME_NAME_WIDTH = 26

function mameValue(value: string): string {
  return value.includes('#') || value !== value.trim() || value === '' ? `"${value}"` : value
}

/**
 * Sets options of a MAME .ini (`name<spaces>value` lines, `#` comments). The value is replaced and the name padded
 * to 26 columns as MAME writes it; values with '#' or edge spaces are double-quoted. Missing options are appended.
 * New files use CRLF.
 */
export async function setMameIni(file: string, values: Record<string, string>): Promise<void> {
  const f = await readText(file, '\r\n')
  const lines = f.lines
  for (const [key, value] of Object.entries(values)) {
    const name = key.length < MAME_NAME_WIDTH ? key.padEnd(MAME_NAME_WIDTH) : `${key} `
    const line = `${name}${mameValue(value)}`
    const i = lines.findIndex((l) => {
      const t = l.trim()
      if (t === '' || t.startsWith('#')) return false
      return t.split(/\s/, 1)[0] === key
    })
    if (i >= 0) lines[i] = line
    else lines.splice(insertionPoint(lines, 0, lines.length), 0, line)
  }
  await writeText(file, f)
}

/**
 * Sets `key = "value"` lines of a RetroArch .cfg (values always double-quoted; RetroArch reads quoted values
 * literally, so backslashes stay as they are). Missing keys are appended. New files use CRLF.
 */
export async function setRetroArchCfg(file: string, values: Record<string, string>): Promise<void> {
  const f = await readText(file, '\r\n')
  const lines = f.lines
  for (const [key, value] of Object.entries(values)) {
    const line = `${key} = "${value}"`
    const i = lines.findIndex((l) => {
      const m = /^\s*([^\s=#]+)\s*=/.exec(l)
      return m !== null && m[1] === key
    })
    if (i >= 0) lines[i] = line
    else lines.splice(insertionPoint(lines, 0, lines.length), 0, line)
  }
  await writeText(file, f)
}

/** The [start, end) body range of the first `[section]` (case-insensitive), or null. */
function iniSectionRange(lines: string[], section: string): { start: number; end: number } | null {
  const wanted = section.trim().toLowerCase()
  for (let i = 0; i < lines.length; i++) {
    const m = INI_SECTION.exec(lines[i])
    if (!m || m[1].trim().toLowerCase() !== wanted) continue
    let end = i + 1
    while (end < lines.length && !INI_SECTION.test(lines[end])) end++
    return { start: i + 1, end }
  }
  return null
}

/**
 * The raw body lines of the first `[section]` of an INI file (section names compare case-insensitively), without
 * the header and without the blank lines that separate it from the next section. Null when the file or the section
 * does not exist; an empty array for a section with no lines. `encoding` as for setIniValues.
 */
export async function readIniSection(
  file: string,
  section: string,
  options?: { encoding?: TextEncoding }
): Promise<string[] | null> {
  const f = await readText(file, '\r\n', options?.encoding)
  if (f.original === null) return null
  return sectionLines(f.lines, section)
}

function sectionLines(lines: string[], section: string): string[] | null {
  const r = iniSectionRange(lines, section)
  if (!r) return null
  return lines.slice(r.start, insertionPoint(lines, r.start, r.end))
}

/**
 * readIniSection on text already read (several sections of one file from a single read). Null when the section does
 * not exist.
 */
export function iniSectionOf(text: string, section: string): string[] | null {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (body === '') return null
  return sectionLines(body.replace(/\r?\n$/, '').split(/\r?\n/), section)
}

/**
 * Replaces the whole body of the first `[section]` (case-insensitive; the header keeps the file's spelling) with
 * `lines`, or appends `[section]` with `lines` at the end of the file. Every other section, and the blank lines
 * after the replaced body, stay as they were. Creates the file (CRLF unless `eol` is 'lf'); an existing file keeps
 * its own line endings. A file whose content does not change is not rewritten. `encoding` as for setIniValues.
 */
export async function replaceIniSection(
  file: string,
  section: string,
  lines: string[],
  options?: { eol?: 'crlf' | 'lf'; encoding?: TextEncoding }
): Promise<void> {
  const f = await readText(file, options?.eol === 'lf' ? '\n' : '\r\n', options?.encoding)
  const r = iniSectionRange(f.lines, section)
  if (r) f.lines.splice(r.start, insertionPoint(f.lines, r.start, r.end) - r.start, ...lines)
  else appendBlock(f.lines, [`[${section}]`, ...lines])
  await writeText(file, f, options?.encoding)
}
