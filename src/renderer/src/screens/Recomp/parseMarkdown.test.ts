import { describe, expect, it } from 'vitest'
import {
  decodeEntities,
  inlineText,
  parseInline,
  parseMarkdown,
  resolveLink
} from './parseMarkdown'

const REPO = 'https://github.com/Zelda64Recomp/Zelda64Recomp'

describe('parseMarkdown blocks', () => {
  it('reads ATX and setext headings, paragraphs and rules', () => {
    const blocks = parseMarkdown(
      '# Zelda 64: Recompiled\n\nA native port.\nSecond line.\n\nInstalling\n---\n\n***\n'
    )
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'heading', 'rule'])
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 })
    expect(blocks[2]).toMatchObject({ type: 'heading', level: 2 })
    const para = blocks[1]
    expect(para.type === 'paragraph' && inlineText(para.children)).toBe(
      'A native port. Second line.'
    )
  })

  it('keeps fenced code as it is, Markdown and HTML included', () => {
    const blocks = parseMarkdown('```sh\n./Zelda64Recompiled --rom "**x**"\n<b>\n```\nafter')
    expect(blocks[0]).toEqual({
      type: 'code',
      lang: 'sh',
      text: './Zelda64Recompiled --rom "**x**"\n<b>'
    })
    expect(blocks[1].type).toBe('paragraph')
  })

  it('reads an unclosed fence to the end', () => {
    expect(parseMarkdown('~~~\ncode')).toEqual([{ type: 'code', lang: '', text: 'code' }])
  })

  it('reads bullet, numbered, nested and task lists', () => {
    const blocks = parseMarkdown(
      '- Widescreen\n- High frame rates\n  - up to 360 FPS\n- [x] Mods\n- [ ] Online\n\n3. Pick the ROM\n4. Play'
    )
    expect(blocks).toHaveLength(2)
    const ul = blocks[0]
    if (ul.type !== 'list') throw new Error('not a list')
    expect(ul.ordered).toBe(false)
    expect(ul.items.map((i) => [inlineText(i.children), i.depth, i.task])).toEqual([
      ['Widescreen', 0, undefined],
      ['High frame rates', 0, undefined],
      ['up to 360 FPS', 1, undefined],
      ['Mods', 0, true],
      ['Online', 0, false]
    ])
    expect(blocks[1]).toMatchObject({ type: 'list', ordered: true, start: 3 })
  })

  it('folds a lazy continuation line into its list item', () => {
    const [list] = parseMarkdown('- Pick your ROM\n  from the menu\n- Done')
    if (list.type !== 'list') throw new Error('not a list')
    expect(list.items.map((i) => inlineText(i.children))).toEqual([
      'Pick your ROM from the menu',
      'Done'
    ])
  })

  it('reads block quotes with their own blocks', () => {
    const [quote] = parseMarkdown('> **Note**\n> You need the USA ROM.')
    expect(quote.type).toBe('quote')
    if (quote.type !== 'quote') return
    expect(quote.children).toHaveLength(1)
    const inner = quote.children[0]
    if (inner.type !== 'paragraph') throw new Error('not a paragraph')
    expect(inlineText(inner.children)).toBe('Note You need the USA ROM.')
  })

  it('reads pipe tables, padding short rows', () => {
    const [table] = parseMarkdown('| Game | Status |\n|:---|---:|\n| MM | Playable |\n| OoT |')
    if (table.type !== 'table') throw new Error('not a table')
    expect(table.header.map(inlineText)).toEqual(['Game', 'Status'])
    expect(table.rows.map((r) => r.map(inlineText))).toEqual([
      ['MM', 'Playable'],
      ['OoT', '']
    ])
  })

  it('drops images, badge rows and HTML, keeping the text', () => {
    const blocks = parseMarkdown(
      '<p align="center"><img src="logo.png"></p>\n\n[![Discord](https://img.shields.io/x.svg)](https://discord.gg/x) ![b](y.png)\n\n<b>Bold</b> text<br>next <!-- hidden -->'
    )
    expect(blocks).toHaveLength(1)
    const para = blocks[0]
    if (para.type !== 'paragraph') throw new Error('not a paragraph')
    expect(para.children).toEqual([
      { type: 'text', text: 'Bold text' },
      { type: 'br' },
      { type: 'text', text: 'next' }
    ])
  })

  it('reads indented code only where it cannot continue a paragraph', () => {
    expect(parseMarkdown('    code here\n\ntext')[0]).toEqual({
      type: 'code',
      lang: '',
      text: 'code here'
    })
    expect(parseMarkdown('text\n    more text')[0].type).toBe('paragraph')
  })

  it('breaks lines on two trailing spaces or a backslash', () => {
    const [para] = parseMarkdown('one  \ntwo\\\nthree')
    if (para.type !== 'paragraph') throw new Error('not a paragraph')
    expect(para.children.filter((r) => r.type === 'br')).toHaveLength(2)
  })

  it('stays bounded on a huge input', () => {
    const blocks = parseMarkdown('a'.repeat(600 * 1024))
    expect(blocks).toHaveLength(1)
    const para = blocks[0]
    expect(para.type === 'paragraph' && inlineText(para.children).length).toBe(256 * 1024)
  })
})

describe('parseInline', () => {
  it('reads code, strong, emphasis and strikethrough', () => {
    expect(parseInline('Run `make` **now** or *later* ~~never~~')).toEqual([
      { type: 'text', text: 'Run ' },
      { type: 'code', text: 'make' },
      { type: 'text', text: ' ' },
      { type: 'strong', children: [{ type: 'text', text: 'now' }] },
      { type: 'text', text: ' or ' },
      { type: 'em', children: [{ type: 'text', text: 'later' }] },
      { type: 'text', text: ' ' },
      { type: 'strike', children: [{ type: 'text', text: 'never' }] }
    ])
  })

  it('leaves snake_case names, lone stars and escapes alone', () => {
    expect(inlineText(parseInline('my_rom_file.z64 costs 2 * 3 \\*not em\\*'))).toBe(
      'my_rom_file.z64 costs 2 * 3 *not em*'
    )
    expect(parseInline('a_b_c')).toEqual([{ type: 'text', text: 'a_b_c' }])
  })

  it('reads links, resolving relative ones against the repository', () => {
    expect(parseInline('[docs](docs/BUILDING.md "Building")', { baseUrl: REPO })).toEqual([
      {
        type: 'link',
        href: `${REPO}/blob/HEAD/docs/BUILDING.md`,
        children: [{ type: 'text', text: 'docs' }]
      }
    ])
    expect(parseInline('[top](#install)')).toEqual([
      { type: 'link', href: null, children: [{ type: 'text', text: 'top' }] }
    ])
  })

  it('links autolinks and bare URLs, leaving trailing punctuation out', () => {
    const runs = parseInline('See <https://example.com/a> and https://example.com/b.')
    const links = runs.filter((r) => r.type === 'link')
    expect(links.map((l) => l.type === 'link' && l.href)).toEqual([
      'https://example.com/a',
      'https://example.com/b'
    ])
    expect(inlineText(runs)).toBe('See https://example.com/a and https://example.com/b.')
  })

  it('handles brackets and parentheses inside links', () => {
    const [link] = parseInline('[Wiki [EN]](https://en.wikipedia.org/wiki/Foo_(bar))')
    expect(link).toMatchObject({
      type: 'link',
      href: 'https://en.wikipedia.org/wiki/Foo_(bar)'
    })
    expect(link.type === 'link' && inlineText(link.children)).toBe('Wiki [EN]')
  })

  it('treats an unmatched marker as text', () => {
    expect(inlineText(parseInline('**open and `tick'))).toBe('**open and `tick')
  })
})

describe('resolveLink', () => {
  it('opens only web links', () => {
    expect(resolveLink('https://x.org/a')).toBe('https://x.org/a')
    expect(resolveLink('www.x.org')).toBe('https://www.x.org')
    expect(resolveLink('javascript:alert(1)', REPO)).toBeNull()
    expect(resolveLink('mailto:a@b.c', REPO)).toBeNull()
    expect(resolveLink('//evil.example/x', REPO)).toBeNull()
    expect(resolveLink('file.md')).toBeNull()
    expect(resolveLink('./file.md', `${REPO}/`)).toBe(`${REPO}/blob/HEAD/file.md`)
    expect(resolveLink('/LICENSE', REPO)).toBe(`${REPO}/blob/HEAD/LICENSE`)
  })
})

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('Tom &amp; Jerry &lt;3 &#39;hi&#x27; &copy; &bogus;')).toBe(
      "Tom & Jerry <3 'hi' © &bogus;"
    )
  })
})
