// @vitest-environment jsdom
import { readFileSync } from 'fs'
import { join } from 'path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Settings > Library "Icons for tabs": with it on, a tab with filters shows its choices' icons (the Filters sub-menus'
 * ones), its name kept as its accessible name and tooltip; off, every tab shows its name as before. All Games and the
 * Settings tab are unchanged either way, and the strip measures itself again when the setting flips.
 */

vi.mock('../../api/client', () => ({
  api: { on: () => () => undefined, updateSettings: () => undefined },
  isMock: false
}))

const { initFocus } = await import('../../input/focus')
const { TabStrip } = await import('./TabStrip')
const { stripTabs, tabFiltersOf, newTabDef } = await import('../../lib/libraryTabs')
const { LIBRARY_SETTINGS_TAB } = await import('../../lib/libraryView')
const libraryCss = readFileSync(join(__dirname, 'library.css'), 'utf8')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The fake layout: with icons the tabs are narrower, so the strip fits its 500px box; with words it does not. */
const VIEWPORT = 500
const strip = (): HTMLElement | null => host.querySelector<HTMLElement>('.library__tabs-strip')
const drawsIcons = (): boolean => !!strip()?.querySelector('.library__tab-icons')
const descriptors: Array<[keyof HTMLElement, PropertyDescriptor | undefined]> = []
function fake(name: keyof HTMLElement, descriptor: PropertyDescriptor): void {
  descriptors.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)])
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor })
}

beforeAll(() => {
  initFocus()
  const has = (el: HTMLElement, name: string): boolean => el.classList.contains(name)
  fake('clientWidth', {
    get(this: HTMLElement) {
      return has(this, 'library__tabs') ? VIEWPORT : 0
    }
  })
  fake('scrollWidth', {
    get(this: HTMLElement) {
      return has(this, 'library__tabs') ? (drawsIcons() ? 400 : 1200) : 0
    }
  })
  fake('offsetWidth', {
    get(this: HTMLElement) {
      if (has(this, 'library__tabs-strip')) return drawsIcons() ? 400 : 1200
      return this.dataset.tabId ? (drawsIcons() ? 60 : 200) : 0
    }
  })
  fake('offsetLeft', {
    get(this: HTMLElement) {
      const index = [...(strip()?.querySelectorAll('[data-tab-id]') ?? [])].indexOf(this)
      return index < 0 ? 0 : 24 + index * (drawsIcons() ? 80 : 220)
    }
  })
  ;(HTMLElement.prototype as { scrollTo?: unknown }).scrollTo = function (): void {
    // The strip only reads its scroll position here.
  }
})

afterAll(() => {
  for (const [name, descriptor] of descriptors.reverse()) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView']
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const TABS = stripTabs(
  [
    newTabDef({}, 'all'),
    newTabDef({ filters: tabFiltersOf({ stores: ['steam', 'epic'], tags: ['rpg'] }) }, 'pc'),
    newTabDef({ filters: tabFiltersOf({ developers: ['FromSoftware'], favorites: true }) }, 'dev'),
    newTabDef({ filters: tabFiltersOf({ developers: ['A', 'B', 'C', 'D', 'E', 'F'] }) }, 'devs'),
    newTabDef({ filters: tabFiltersOf({ platforms: ['snes', 'no-such-system', 'psx'] }) }, 'mixed'),
    newTabDef(
      {
        filters: tabFiltersOf({
          platforms: ['snes', 'psx'],
          sizes: ['gb-0-1', 'gb-1-5'],
          hltb: ['h-0-3'],
          hidden: true
        })
      },
      'many'
    )
  ],
  (id) => id.toUpperCase()
)

function mount(icons: boolean, active = 'pc'): void {
  act(() =>
    root.render(
      <TabStrip
        tabs={TABS}
        active={active}
        onSelect={() => undefined}
        onUp={() => true}
        onAdd={() => undefined}
        icons={icons}
      />
    )
  )
}

const tab = (id: string): HTMLElement => host.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!
const labelOf = (id: string): string => TABS.find((t) => t.id === id)!.label

describe('TabStrip "Icons for tabs"', () => {
  it('shows a tab’s choices as icons, its name kept as aria-label and tooltip', () => {
    mount(true)
    const pc = tab('pc')
    expect(pc.querySelector('.library__tab-icons')).not.toBeNull()
    expect(pc.querySelectorAll('.library__tab-choice')).toHaveLength(3)
    expect(pc.textContent).toBe('')
    expect(pc.getAttribute('aria-label')).toBe(labelOf('pc'))
    expect(pc.getAttribute('title')).toBe(labelOf('pc'))
    // Two filters, both drawn: a wider gap instead of a dot.
    expect(pc.querySelector('.library__tab-filter--gap')).not.toBeNull()
    expect(pc.querySelector('.library__tab-sep')).toBeNull()
  })

  it('keeps the words of a choice without an icon, a "·" between it and the next filter', () => {
    mount(true)
    const dev = tab('dev')
    expect(dev.querySelector('.library__tab-word')?.textContent).toBe('FromSoftware')
    expect(dev.querySelector('.library__tab-sep')?.textContent).toBe('·')
    expect(dev.querySelector('[data-choice="favorites:favorites"]')).not.toBeNull()
    expect(dev.getAttribute('aria-label')).toBe(labelOf('dev'))
  })

  it('draws at most five choices, then +N', () => {
    mount(true)
    const many = tab('many')
    expect(many.querySelectorAll('.library__tab-choice, .library__tab-word')).toHaveLength(5)
    expect(many.querySelector('.library__tab-more')?.textContent).toBe('+1')
  })

  it('keeps the name of a tab none of whose choices has an icon, all of it, with no +N', () => {
    mount(true)
    const devs = tab('devs')
    expect(devs.querySelector('.library__tab-icons')).toBeNull()
    expect(devs.textContent).toBe(labelOf('devs'))
    expect(devs.hasAttribute('aria-label')).toBe(false)
  })

  it('puts a "+" between an icon and a choice kept as words in one filter', () => {
    mount(true)
    const mixed = tab('mixed')
    const row = [...mixed.querySelector('.library__tab-filter')!.children].map((el) =>
      el.classList.contains('library__tab-sep') ? el.textContent : el.getAttribute('data-choice')
    )
    expect(row).toEqual(['platform:snes', '+', 'platform:no-such-system', '+', 'platform:psx'])
  })

  it('lets hover reach the tab, so its tooltip is its full name, not a badge’s own title', () => {
    // A store badge keeps its own title; the icon row takes no pointer, so the tab's title is the one shown.
    expect(libraryCss).toMatch(/\.library__tab-icons\s*\{[^}]*pointer-events:\s*none/)
  })

  it('dims an inactive tab’s icons one by one, not the row, so words and flags are not dimmed', () => {
    // A child cannot undo its parent's opacity: the row itself must have none.
    expect(libraryCss).not.toMatch(/\.library__tab-icons\s*\{[^}]*opacity/)
    expect(libraryCss).toMatch(
      /\.library__tab-choice:not\(:has\(\.library__tab-flag\)\)\s*\{[^}]*opacity/
    )
  })

  it('leaves All Games and the Settings tab as they are', () => {
    mount(true)
    expect(tab('all').textContent).toBe(labelOf('all'))
    expect(tab('all').hasAttribute('aria-label')).toBe(false)
    expect(tab(LIBRARY_SETTINGS_TAB).querySelector('.library__tab-icon')).not.toBeNull()
    expect(tab(LIBRARY_SETTINGS_TAB).querySelector('.library__tab-icons')).toBeNull()
  })

  it('off: every tab shows its name as before', () => {
    mount(false)
    expect(host.querySelector('.library__tab-icons')).toBeNull()
    for (const id of ['all', 'pc', 'dev', 'many']) {
      expect(tab(id).textContent).toBe(labelOf(id))
      expect(tab(id).hasAttribute('aria-label')).toBe(false)
      expect(tab(id).hasAttribute('title')).toBe(false)
    }
  })

  it('measures the strip again when the setting flips: the scroll bar and the underline follow', () => {
    mount(false)
    const scrolls = (): boolean => !!host.querySelector('.library__tabs-group--scrolls')
    const underline = (): string =>
      host.querySelector<HTMLElement>('.library__tab-underline')!.style.getPropertyValue('--x')
    expect(scrolls()).toBe(true)
    const wordsX = underline()
    mount(true)
    expect(scrolls()).toBe(false)
    expect(underline()).not.toBe(wordsX)
    mount(false)
    expect(scrolls()).toBe(true)
    expect(underline()).toBe(wordsX)
  })
})
