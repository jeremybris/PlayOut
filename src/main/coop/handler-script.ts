/**
 * What PlayOut reads from a Nucleus Co-op handler script (handler.js) without running it: the fields that say which
 * game it is for and what it needs. Handlers set them as top-level `Game.X = value;` (and `Hub.Handler.Id/Version`)
 * assignments, which is also how Nucleus itself reads the name and exe at install time (a line scan). The script
 * runs only in the Co-Op helper, when the game is played.
 */

import type { CoopHandlerScript, CoopRiskTool } from '@shared/types'

export type HandlerScriptInfo = CoopHandlerScript

type Value = string | number | boolean | string[]

/** A JS literal: "str" / 'str', a number, true/false, or an array of those (as strings). undefined otherwise. */
export function parseLiteral(text: string): Value | undefined {
  const t = text.trim()
  if (t === 'true' || t === 'false') return t === 'true'
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  const str = /^(["'])((?:\\.|(?!\1).)*)\1$/.exec(t)
  if (str) return unescape(str[2]!)
  if (t.startsWith('[') && t.endsWith(']')) {
    const items: string[] = []
    const re = /(["'])((?:\\.|(?!\1).)*)\1|(-?\d+(?:\.\d+)?)|(true|false)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(t.slice(1, -1))))
      items.push(m[2] !== undefined ? unescape(m[2]) : (m[3] ?? m[4])!)
    return items
  }
  return undefined
}

function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c
  )
}

/** Words after which a `/` starts a regex literal, not a division. */
const REGEX_AFTER_WORD = /^(return|typeof|case|in|of|void|delete|throw|new|else|do|instanceof)$/

/**
 * Whether a `/` at text[at] can start a regex literal, judged by what comes before it: an operator, an opening
 * bracket, a statement end, one of the words above, or nothing at all. After a value (a name, a number, a string,
 * `)` or `]`) it is a division.
 */
function regexCanStart(text: string, at: number): boolean {
  let i = at - 1
  while (i >= 0 && /\s/.test(text[i]!)) i--
  if (i < 0) return true
  const c = text[i]!
  // `a++ / 2`: a division after a postfix operator.
  if ((c === '+' || c === '-') && text[i - 1] === c) return false
  if ('(,=:[!&|?{};+-*%<>~^'.includes(c)) return true
  if (!/[A-Za-z0-9_$]/.test(c)) return false
  let start = i
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1]!)) start--
  return REGEX_AFTER_WORD.test(text.slice(start, i + 1))
}

/**
 * The index just past the regex literal whose opening `/` is at text[start] (flags included), or -1 when the line
 * ends before it closes, which makes that `/` a division. Backslash escapes and [...] classes (where `/` does not
 * close the literal) are honoured.
 */
function regexEnd(text: string, start: number): number {
  let inClass = false
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]!
    if (c === '\n' || c === '\r') return -1
    if (c === '\\') i++
    else if (inClass) inClass = c !== ']'
    else if (c === '[') inClass = true
    else if (c === '/') {
      let end = i + 1
      while (end < text.length && /[A-Za-z]/.test(text[end]!)) end++
      return end
    }
  }
  return -1
}

/**
 * The script's text with comments removed. Strings and regex literals are kept intact: "https://..." is not a
 * comment, and neither is the // in /[//]/ or the quote in /"/g the start of a string.
 */
export function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < source.length) {
    const c = source[i]!
    const next = source[i + 1]
    if (quote) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (c === quote || c === '\n') quote = null
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      // Newlines kept, so line-based reading still lines up.
      out += source.slice(i, end < 0 ? source.length : end + 2).replace(/[^\n]/g, '')
      i = end < 0 ? source.length : end + 2
      continue
    }
    if (c === '/' && regexCanStart(out, out.length)) {
      const end = regexEnd(source, i)
      if (end > 0) {
        out += source.slice(i, end)
        i = end
        continue
      }
    }
    out += c
    i++
  }
  return out
}

/**
 * The top-level `Game.X = value` / `Hub.Handler.X = value` assignments of a script: the first one of each field
 * (handlers set identity fields once at the top). Arrays may span lines. Assignments inside functions
 * (Game.Play = function () { ... }) are indented within braces and are skipped.
 */
export function readAssignments(source: string): Map<string, Value> {
  const text = stripComments(source)
  const out = new Map<string, Value>()
  const re = /^[ \t]*(Game|Hub\.Handler)\.([A-Za-z0-9_]+)[ \t]*=[ \t]*/gm
  let depth = 0
  let scanned = 0
  let quote: string | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    // Brace depth between the previous match and this one. Braces inside string literals do not count (a
    // description saying "press {" must not hide the fields after it); a string ends at its quote or, unterminated,
    // at the end of its line, as in stripComments. A regex literal is passed over whole, so a quote or a brace
    // inside one (/["']/, /\d{2}/) neither starts a string nor counts.
    for (let i = scanned; i < m.index; i++) {
      const ch = text[i]!
      if (quote) {
        if (ch === '\\') i++
        else if (ch === quote || ch === '\n') quote = null
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '{') depth++
      else if (ch === '}') depth = Math.max(0, depth - 1)
      else if (ch === '/' && regexCanStart(text, i)) {
        const end = regexEnd(text, i)
        if (end > 0) i = end - 1
      }
    }
    scanned = m.index
    if (depth > 0) continue
    const start = re.lastIndex
    let end: number
    if (text[start] === '[') {
      const close = text.indexOf(']', start)
      end = close < 0 ? text.indexOf('\n', start) : close + 1
    } else {
      const nl = text.indexOf('\n', start)
      end = nl < 0 ? text.length : nl
    }
    const raw = text.slice(start, end).replace(/;\s*$/, '').trim()
    const key = `${m[1] === 'Game' ? '' : 'Hub.'}${m[2]}`
    const value = parseLiteral(raw)
    if (value !== undefined && !out.has(key)) out.set(key, value)
  }
  return out
}

const str = (v: Value | undefined): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined
const num = (v: Value | undefined): number | undefined =>
  typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined
const list = (v: Value | undefined): string[] =>
  Array.isArray(v) ? v.filter(Boolean) : typeof v === 'string' && v ? [v] : []

/** A handler script's identity and needs; null when it names no game (not a handler). */
export function parseHandlerScript(source: string): HandlerScriptInfo | null {
  const a = readAssignments(source)
  const gameName = str(a.get('GameName'))?.trim()
  if (!gameName) return null
  const risks: CoopRiskTool[] = []
  if (a.get('UseSteamless') === true || Array.isArray(a.get('SteamlessPatch')))
    risks.push('steamless')
  if (a.get('NeedsSteamEmulation') === true) risks.push('smartsteamemu')
  if (a.get('UseSteamStubDRMPatcher') === true) risks.push('steamstub')
  if (a.get('UseEACBypass') === true) risks.push('eac')
  return {
    gameName,
    exeName: str(a.get('ExecutableName'))?.trim() || undefined,
    exeNames: list(a.get('ExecutableNames')),
    exeContext: list(a.get('ExecutableContext')),
    steamId: str(a.get('SteamID'))?.trim() || undefined,
    guid: str(a.get('GUID'))?.trim() || undefined,
    binariesFolder: str(a.get('BinariesFolder'))?.trim() || undefined,
    maxPlayers: num(a.get('MaxPlayers')),
    maxPlayersOneMonitor: num(a.get('MaxPlayersOneMonitor')),
    supportsKeyboard: a.get('SupportsKeyboard') === true,
    supportsMultipleKeyboardsAndMice: a.get('SupportsMultipleKeyboardsAndMice') === true,
    hubId: str(a.get('Hub.Id'))?.trim() || undefined,
    hubVersion: num(a.get('Hub.Version')),
    risks
  }
}

/** Nucleus's file name for an installed handler: the game name without \ / : * ? " < > | (DownloadPrompt.cs). */
export function handlerFileName(gameName: string): string {
  const name = gameName
    .replace(/[\\/:*?"<>|]/g, '')
    .split('')
    .filter((c) => c.charCodeAt(0) >= 32)
    .join('')
    .trim()
    // Windows drops trailing dots and spaces from file names.
    .replace(/[. ]+$/, '')
  // Nothing usable left ("..", "???"), or a device name: a name that cannot leave the handlers folder.
  if (!name || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name))
    return `handler-${hash(gameName)}`
  return name
}

function hash(text: string): string {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16)
}
