/**
 * A small Markdown reader for the Recompilation page: a project's README, its description and its release notes
 * (GitHub-flavoured Markdown written by the developers). It turns the text into plain data (blocks and inline runs)
 * that Markdown.tsx renders with React elements, so nothing from the text ever reaches the page as HTML.
 *
 * Covered: ATX and setext headings, paragraphs, bullet / numbered / task lists (nesting kept as a depth), fenced
 * and indented code, block quotes, rules, pipe tables, and inline code, strong, emphasis, strikethrough, links
 * (relative ones resolved against the repository), autolinks and bare URLs. Raw HTML tags are dropped (their text
 * stays), images and badge rows are left out (the page shows no remote images from a README), and HTML entities
 * are decoded.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'strike'; children: Inline[] }
  | { type: 'code'; text: string }
  /** `href` null: a link PlayOut cannot open (an anchor in the page, mailto:, javascript:): shown as text. */
  | { type: 'link'; href: string | null; children: Inline[] }
  | { type: 'br' }

export interface ListItem {
  /** Nesting level, 0 = top. */
  depth: number
  /** A task list item: checked or not; undefined = an ordinary item. */
  task?: boolean
  children: Inline[]
}

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; children: Block[] }
  | { type: 'rule' }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][] }

export interface MarkdownOptions {
  /**
   * Where relative links point: the repository page ("https://github.com/owner/repo"); a relative link becomes
   * "<base>/blob/HEAD/<path>". Without it relative links are shown as text.
   */
  baseUrl?: string
}

/** Longest text read (the README fetch is capped at 200 KB already; this keeps a pathological one cheap). */
const MAX_LENGTH = 256 * 1024
/** Deepest block-quote nesting followed. */
const MAX_QUOTE_DEPTH = 4

/** Parse Markdown into blocks. */
export function parseMarkdown(source: string, options: MarkdownOptions = {}): Block[] {
  const text = prepare(source.length > MAX_LENGTH ? source.slice(0, MAX_LENGTH) : source)
  return parseBlocks(text.split('\n'), options, 0)
}

/** Line endings, tabs, HTML comments and autolinks (before tags are dropped, as `<https://…>` looks like one). */
function prepare(source: string): string {
  return source
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/
const ATX = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
const SETEXT_1 = /^ {0,3}=+\s*$/
const SETEXT_2 = /^ {0,3}-+\s*$/

function parseBlocks(lines: string[], options: MarkdownOptions, quoteDepth: number): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const children = parseParagraphInline(paragraph, options)
    paragraph = []
    if (hasContent(children)) blocks.push({ type: 'paragraph', children })
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Fenced code: everything up to the closing fence (or the end) as it is.
    const fence = FENCE.exec(line)
    if (fence) {
      flushParagraph()
      const marker = fence[1]
      const body: string[] = []
      i++
      while (i < lines.length && !closesFence(lines[i], marker)) {
        body.push(lines[i])
        i++
      }
      i++ // the closing fence
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: decodeEntities(body.join('\n')) })
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      i++
      continue
    }

    // Indented code (4 spaces), only where it cannot be a paragraph's continuation.
    if (paragraph.length === 0 && /^ {4,}\S/.test(line) && !LIST_ITEM.test(line)) {
      const body: string[] = []
      while (i < lines.length && (/^ {4}/.test(lines[i]) || lines[i].trim() === '')) {
        body.push(lines[i].slice(4))
        i++
      }
      while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
      blocks.push({ type: 'code', lang: '', text: body.join('\n') })
      continue
    }

    // Setext headings: a paragraph line underlined with === or ---.
    if (paragraph.length > 0 && (SETEXT_1.test(line) || SETEXT_2.test(line))) {
      const level = SETEXT_1.test(line) ? 1 : 2
      const children = parseParagraphInline(paragraph, options)
      paragraph = []
      if (hasContent(children)) blocks.push({ type: 'heading', level, children })
      i++
      continue
    }

    const atx = ATX.exec(line)
    if (atx) {
      flushParagraph()
      const children = parseInline(stripHtml(atx[2] ?? ''), options)
      if (hasContent(children)) {
        blocks.push({ type: 'heading', level: atx[1].length as 1 | 2 | 3 | 4 | 5 | 6, children })
      }
      i++
      continue
    }

    if (RULE.test(line)) {
      flushParagraph()
      blocks.push({ type: 'rule' })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      flushParagraph()
      const body: string[] = []
      while (i < lines.length && lines[i].trim() !== '') {
        const m = QUOTE.exec(lines[i])
        body.push(m ? m[1] : lines[i])
        i++
      }
      const children =
        quoteDepth < MAX_QUOTE_DEPTH
          ? parseBlocks(body, options, quoteDepth + 1)
          : [{ type: 'paragraph' as const, children: parseParagraphInline(body, options) }]
      if (children.length > 0) blocks.push({ type: 'quote', children })
      continue
    }

    // Pipe table: a header row followed by the |---|---| divider.
    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      flushParagraph()
      const header = splitRow(line).map((cell) => parseInline(stripHtml(cell), options))
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        const cells = splitRow(lines[i]).map((cell) => parseInline(stripHtml(cell), options))
        while (cells.length < header.length) cells.push([])
        rows.push(cells.slice(0, Math.max(header.length, 1)))
        i++
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    const item = LIST_ITEM.exec(line)
    if (item && (paragraph.length === 0 || item[1].length === 0)) {
      flushParagraph()
      const ordered = /\d/.test(item[2])
      const start = ordered ? Number.parseInt(item[2], 10) : 1
      const items: ListItem[] = []
      // Indents of the open levels, to turn indentation into depth.
      const indents: number[] = []
      let current: { depth: number; lines: string[] } | null = null
      const pushCurrent = (): void => {
        if (!current) return
        items.push(listItem(current.depth, current.lines, options))
        current = null
      }
      while (i < lines.length) {
        const l = lines[i]
        const m = LIST_ITEM.exec(l)
        if (m) {
          const indent = m[1].length
          // A top-level item of the other kind (bullets after numbers) starts a list of its own.
          const topLevel = indents.length === 0 || indent <= indents[0]
          if (topLevel && items.length + (current ? 1 : 0) > 0 && /\d/.test(m[2]) !== ordered) break
          while (indents.length > 0 && indent < indents[indents.length - 1]) indents.pop()
          if (indents.length === 0 || indent > indents[indents.length - 1]) indents.push(indent)
          pushCurrent()
          current = { depth: Math.min(indents.length - 1, 5), lines: [m[3]] }
          i++
          continue
        }
        if (l.trim() === '') {
          // A blank line ends the list unless the next line carries on with an item or an indented line.
          const next = lines[i + 1]
          if (next !== undefined && (LIST_ITEM.test(next) || /^ {2,}\S/.test(next))) {
            i++
            continue
          }
          break
        }
        // A lazy continuation line (indented, or plain text right after the item).
        if (current && (/^\s+\S/.test(l) || !startsBlock(l))) {
          ;(current as { lines: string[] }).lines.push(l.trim())
          i++
          continue
        }
        break
      }
      pushCurrent()
      if (items.length > 0) blocks.push({ type: 'list', ordered, start, items })
      continue
    }

    paragraph.push(line)
    i++
  }
  flushParagraph()
  return blocks
}

function closesFence(line: string, marker: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith(marker) && /^[`~]+$/.test(trimmed)
}

/** Whether a line opens a block of its own (and so cannot continue a list item lazily). */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    ATX.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line)
  )
}

function listItem(depth: number, lines: string[], options: MarkdownOptions): ListItem {
  let first = lines[0] ?? ''
  let task: boolean | undefined
  const box = /^\[( |x|X)\]\s+/.exec(first)
  if (box) {
    task = box[1] !== ' '
    first = first.slice(box[0].length)
  }
  const children = parseParagraphInline([first, ...lines.slice(1)], options)
  return task === undefined ? { depth, children } : { depth, task, children }
}

function splitRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]
    if (ch === '\\' && row[i + 1] === '|') {
      cell += '|'
      i++
    } else if (ch === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += ch
  }
  cells.push(cell.trim())
  return cells
}

/** Paragraph lines: a line ending in two spaces or a backslash breaks; other newlines read as spaces. */
function parseParagraphInline(lines: string[], options: MarkdownOptions): Inline[] {
  const out: Inline[] = []
  lines.forEach((raw, index) => {
    const last = index === lines.length - 1
    const hard = !last && (/ {2,}$/.test(raw) || /\\$/.test(raw))
    let line = raw.replace(/\\$/, '').trim()
    // An HTML <br> is a line break too.
    const parts = stripHtml(line.replace(/<br\s*\/?>/gi, '\u0000')).split('\u0000')
    parts.forEach((part, p) => {
      if (p > 0) out.push({ type: 'br' })
      line = part
      out.push(...parseInline(line, options))
    })
    if (!last) out.push(hard ? { type: 'br' } : { type: 'text', text: ' ' })
  })
  return mergeText(trimBreaks(out))
}

function trimBreaks(runs: Inline[]): Inline[] {
  let start = 0
  let end = runs.length
  const blank = (r: Inline): boolean =>
    r.type === 'br' || (r.type === 'text' && r.text.trim() === '')
  while (start < end && blank(runs[start])) start++
  while (end > start && blank(runs[end - 1])) end--
  return runs.slice(start, end)
}

/** Drop HTML tags (keeping their text); autolinks become Markdown links first. */
export function stripHtml(text: string): string {
  return text
    .replace(/<((?:https?:\/\/|www\.)[^>\s]+)>/gi, '[$1]($1)')
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g, '')
}

/** Parse inline Markdown. */
export function parseInline(text: string, options: MarkdownOptions = {}): Inline[] {
  return mergeText(inline(text, options, 0))
}

const MAX_INLINE_DEPTH = 6

function inline(text: string, options: MarkdownOptions, depth: number): Inline[] {
  const out: Inline[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer) out.push(...linkifyText(decodeEntities(buffer)))
    buffer = ''
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const rest = text.slice(i)

    if (ch === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(text[i + 1])) {
      buffer += text[i + 1]
      i += 2
      continue
    }

    if (ch === '`') {
      const ticks = /^`+/.exec(rest)![0]
      const close = text.indexOf(ticks, i + ticks.length)
      if (close > 0) {
        flush()
        out.push({ type: 'code', text: text.slice(i + ticks.length, close).trim() })
        i = close + ticks.length
        continue
      }
      buffer += ticks
      i += ticks.length
      continue
    }

    // Images (and so badge rows) are left out; a linked image leaves an empty link, dropped below.
    if (ch === '!' && text[i + 1] === '[') {
      const image = bracketed(text, i + 1)
      if (image) {
        i = image.end
        continue
      }
    }

    if (ch === '<') {
      const auto = /^<((?:https?:\/\/|www\.)[^>\s]+)>/i.exec(rest)
      if (auto) {
        flush()
        out.push({
          type: 'link',
          href: resolveLink(auto[1], options.baseUrl),
          children: [{ type: 'text', text: auto[1] }]
        })
        i += auto[0].length
        continue
      }
    }

    if (ch === '[') {
      const link = bracketed(text, i)
      if (link) {
        flush()
        const children =
          depth < MAX_INLINE_DEPTH ? mergeText(inline(link.label, options, depth + 1)) : []
        if (hasContent(children)) {
          out.push({ type: 'link', href: resolveLink(link.href, options.baseUrl), children })
        }
        i = link.end
        continue
      }
    }

    if (depth < MAX_INLINE_DEPTH) {
      const strong = delimited(text, i, ['**', '__'])
      if (strong) {
        flush()
        out.push({ type: 'strong', children: inline(strong.inner, options, depth + 1) })
        i = strong.end
        continue
      }
      const strike = delimited(text, i, ['~~'])
      if (strike) {
        flush()
        out.push({ type: 'strike', children: inline(strike.inner, options, depth + 1) })
        i = strike.end
        continue
      }
      const em = delimited(text, i, ['*', '_'])
      if (em) {
        flush()
        out.push({ type: 'em', children: inline(em.inner, options, depth + 1) })
        i = em.end
        continue
      }
    }

    buffer += ch
    i++
  }
  flush()
  return out
}

/** `[label](href "title")` starting at `start` (the `[`), with nested brackets in the label. */
function bracketed(
  text: string,
  start: number
): { label: string; href: string; end: number } | null {
  let depth = 0
  let close = -1
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close < 0 || text[close + 1] !== '(') return null
  let parens = 0
  let end = -1
  for (let i = close + 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') parens++
    else if (ch === ')') {
      parens--
      if (parens === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return null
  const target = text
    .slice(close + 2, end)
    .trim()
    .replace(/\s+(?:"[^"]*"|'[^']*')$/, '')
    .replace(/^<(.*)>$/, '$1')
  return { label: text.slice(start + 1, close), href: target, end: end + 1 }
}

/**
 * Text between a pair of `markers` at `start`: the opening one must be followed by a non-space, the closing one
 * preceded by one; `_` only at word edges (snake_case names stay as they are).
 */
function delimited(
  text: string,
  start: number,
  markers: string[]
): { inner: string; end: number } | null {
  for (const marker of markers) {
    if (!text.startsWith(marker, start)) continue
    const after = text[start + marker.length]
    if (after === undefined || /\s/.test(after)) continue
    if (marker.length === 1 && after === marker) continue
    if (marker[0] === '_' && start > 0 && /\w/.test(text[start - 1])) continue
    let from = start + marker.length + 1
    while (from <= text.length) {
      const close = text.indexOf(marker, from)
      if (close < 0) break
      const before = text[close - 1]
      const following = text[close + marker.length]
      const doubled = marker.length === 1 && following === marker
      const wordAfter = marker[0] === '_' && following !== undefined && /\w/.test(following)
      if (!/\s/.test(before) && !doubled && !wordAfter) {
        return { inner: text.slice(start + marker.length, close), end: close + marker.length }
      }
      from = close + (doubled ? 2 : 1)
    }
  }
  return null
}

const BARE_URL = /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]]/g

/** Bare http(s) URLs in plain text become links. */
function linkifyText(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of text.matchAll(BARE_URL)) {
    const at = m.index ?? 0
    if (at > last) out.push({ type: 'text', text: text.slice(last, at) })
    out.push({ type: 'link', href: m[0], children: [{ type: 'text', text: m[0] }] })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

/**
 * A link PlayOut can open in the browser: http(s) as it is, a relative path against the repository page
 * (`<base>/blob/HEAD/<path>`), else null (an in-page anchor, mailto:, javascript:, ...).
 */
export function resolveLink(href: string, baseUrl?: string): string | null {
  const target = decodeEntities(href.trim())
  if (!target || target.startsWith('#')) return null
  if (/^https?:\/\//i.test(target)) return target
  if (/^www\./i.test(target)) return `https://${target}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return null
  const base = baseUrl.replace(/\/+$/, '')
  if (target.startsWith('/')) {
    // Root-relative: on GitHub that is the site root; inside a repo README it means the repository root.
    return `${base}/blob/HEAD${target}`
  }
  const path = target.replace(/^\.\//, '')
  return `${base}/blob/HEAD/${path}`
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  rarr: '→',
  larr: '←'
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** Whether runs show anything (a paragraph of only badges / images is left out). */
function hasContent(runs: Inline[]): boolean {
  return runs.some((r) =>
    r.type === 'text'
      ? r.text.trim() !== ''
      : r.type === 'br'
        ? false
        : r.type === 'code'
          ? r.text !== ''
          : hasContent(r.children)
  )
}

/** Join neighbouring text runs. */
function mergeText(runs: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const run of runs) {
    const prev = out[out.length - 1]
    if (run.type === 'text' && prev?.type === 'text') {
      out[out.length - 1] = { type: 'text', text: prev.text + run.text }
    } else if (run.type === 'text' && run.text === '') {
      continue
    } else out.push(run)
  }
  return out
}

/** The plain text of inline runs (for a release's one-line summary). */
export function inlineText(runs: Inline[]): string {
  return runs
    .map((r) =>
      r.type === 'text' || r.type === 'code'
        ? r.text
        : r.type === 'br'
          ? ' '
          : inlineText(r.children)
    )
    .join('')
}
