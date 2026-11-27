// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { STICK_SCROLL_SPEED, stickScroll, stickScrollTarget } from './stickScroll'

/** A box that scrolls: jsdom has no layout, so its sizes are given. */
function box(width: number, height: number, content: number, overflow = 'auto'): HTMLElement {
  const el = document.createElement('div')
  el.style.overflowY = overflow
  Object.defineProperty(el, 'clientWidth', { value: width })
  Object.defineProperty(el, 'clientHeight', { value: height })
  Object.defineProperty(el, 'scrollHeight', { value: content })
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('stickScrollTarget', () => {
  it("picks a modal's main scrolling box, not a narrow column beside it", () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const nav = box(200, 600, 700)
    const content = box(700, 600, 1400)
    const tab = document.createElement('button')
    tab.setAttribute('data-focused', 'true')
    nav.append(tab)
    dialog.append(nav, content)
    document.body.append(dialog)
    // Focus on the column of sections: the content scrolls.
    expect(stickScrollTarget()).toBe(content)
    // Focus inside the content: the content.
    tab.removeAttribute('data-focused')
    const row = document.createElement('div')
    row.setAttribute('data-focused', 'true')
    content.append(row)
    expect(stickScrollTarget()).toBe(content)
  })

  it("scrolls only an open drop-down's own list, never the page behind it", () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const content = box(700, 600, 1400)
    dialog.append(content)
    const menu = document.createElement('div')
    menu.style.position = 'fixed'
    const list = box(200, 300, 900)
    const option = document.createElement('div')
    option.setAttribute('data-focused', 'true')
    list.append(option)
    menu.append(list)
    document.body.append(dialog, menu)
    expect(stickScrollTarget()).toBe(list)
    // A short list that does not scroll: nothing does.
    const short = document.createElement('div')
    short.style.position = 'fixed'
    const item = document.createElement('div')
    short.append(item)
    document.body.append(short)
    option.removeAttribute('data-focused')
    item.setAttribute('data-focused', 'true')
    expect(stickScrollTarget()).toBeNull()
  })

  it('skips boxes that do not scroll or have nothing to scroll', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.append(box(700, 600, 1400, 'hidden'), box(700, 600, 500))
    document.body.append(dialog)
    expect(stickScrollTarget()).toBeNull()
  })
})

describe('stickScroll', () => {
  it('scrolls faster the further the stick is pushed, and up for up', () => {
    const el = box(700, 600, 4000)
    stickScroll(el, 1, 1000 / 20)
    expect(el.scrollTop).toBeCloseTo(STICK_SCROLL_SPEED / 20, 0)
    const full = el.scrollTop
    el.scrollTop = 0
    stickScroll(el, 0.5, 1000 / 20)
    expect(el.scrollTop).toBeLessThan(full / 2)
    el.scrollTop = 500
    stickScroll(el, -1, 1000 / 20)
    expect(el.scrollTop).toBeLessThan(500)
  })
})
