import { memo, useMemo, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { api } from '../../api/client'
import { cx } from '../../lib/cx'
import { createLog } from '../../lib/log'
import { parseMarkdown, type Block, type Inline } from './parseMarkdown'

const log = createLog('recomp')

export interface MarkdownProps {
  /** The Markdown text (a README, a description, release notes). */
  text: string
  /** The repository page relative links resolve against. */
  baseUrl?: string
  className?: string
}

/**
 * Markdown as React elements (markdown.ts parses it; no HTML from the text reaches the page). Links open in the
 * browser. Read-only text: it takes no gamepad focus (the page scrolls it with the right stick).
 */
export const Markdown = memo(function Markdown({
  text,
  baseUrl,
  className
}: MarkdownProps): ReactElement {
  const blocks = useMemo(() => parseMarkdown(text, { baseUrl }), [text, baseUrl])
  return <div className={cx('md', className)}>{renderBlocks(blocks)}</div>
})

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((block, index) => renderBlock(block, index))
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case 'heading': {
      // Headings inside the page sit under its own section titles: h1 reads as h3, and so on.
      const level = Math.min(6, block.level + 2)
      const Tag = `h${level}` as 'h3' | 'h4' | 'h5' | 'h6'
      return (
        <Tag key={key} className={cx('md__heading', `md__heading--${block.level}`)}>
          {renderInline(block.children)}
        </Tag>
      )
    }
    case 'paragraph':
      return (
        <p key={key} className="md__p">
          {renderInline(block.children)}
        </p>
      )
    case 'list': {
      const items = block.items.map((item, i) => (
        <li
          key={i}
          className={cx('md__li', item.task !== undefined && 'md__li--task')}
          style={item.depth > 0 ? { marginLeft: `${item.depth * 2.4}rem` } : undefined}
        >
          {item.task !== undefined ? (
            <span className={cx('md__check', item.task && 'md__check--done')} aria-hidden="true">
              {item.task ? '✓' : ''}
            </span>
          ) : null}
          {renderInline(item.children)}
        </li>
      ))
      return block.ordered ? (
        <ol key={key} className="md__list" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key} className="md__list">
          {items}
        </ul>
      )
    }
    case 'code':
      return (
        <pre key={key} className="md__pre">
          <code>{block.text}</code>
        </pre>
      )
    case 'quote':
      return (
        <blockquote key={key} className="md__quote">
          {renderBlocks(block.children)}
        </blockquote>
      )
    case 'rule':
      return <hr key={key} className="md__rule" />
    case 'table':
      return (
        <div key={key} className="md__table-wrap">
          <table className="md__table">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i}>{renderInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i}>{renderInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

function renderInline(runs: Inline[]): ReactNode[] {
  return runs.map((run, index) => {
    switch (run.type) {
      case 'text':
        return run.text
      case 'br':
        return <br key={index} />
      case 'code':
        return (
          <code key={index} className="md__code">
            {run.text}
          </code>
        )
      case 'strong':
        return <strong key={index}>{renderInline(run.children)}</strong>
      case 'em':
        return <em key={index}>{renderInline(run.children)}</em>
      case 'strike':
        return <s key={index}>{renderInline(run.children)}</s>
      case 'link':
        return run.href ? (
          <a
            key={index}
            className="md__link"
            href={run.href}
            title={run.href}
            onClick={(event) => openLink(event, run.href!)}
          >
            {renderInline(run.children)}
          </a>
        ) : (
          <span key={index}>{renderInline(run.children)}</span>
        )
    }
  })
}

/** Links open in the user's browser, never inside PlayOut's window. */
function openLink(event: MouseEvent<HTMLAnchorElement>, href: string): void {
  event.preventDefault()
  event.stopPropagation()
  api.openExternal(href).catch((err) => log.warn('openExternal failed', err))
}
