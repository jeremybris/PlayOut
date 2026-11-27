import { describe, expect, it, vi } from 'vitest'

// keyboard.ts imports the action bus and the focus engine (needs a window): stub both.
vi.mock('./focus', () => ({ getCurrentFocusKey: vi.fn(() => null), releaseEnter: vi.fn() }))
vi.mock('./actions', () => ({ dispatchAction: vi.fn() }))

import { actionForKey, editableLeaveDirection, onWindowBlurReleaseText } from './keyboard'

const key = (
  k: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}
): { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean } => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods
})

describe('editableLeaveDirection', () => {
  it('hands ArrowUp / ArrowDown inside a text input to the focus engine', () => {
    expect(editableLeaveDirection(key('ArrowDown'))).toBe('down')
    expect(editableLeaveDirection(key('ArrowUp'))).toBe('up')
  })

  it('leaves horizontal arrows, typing and Backspace with the input', () => {
    expect(editableLeaveDirection(key('ArrowLeft'))).toBeNull()
    expect(editableLeaveDirection(key('ArrowRight'))).toBeNull()
    expect(editableLeaveDirection(key('a'))).toBeNull()
    expect(editableLeaveDirection(key('Backspace'))).toBeNull()
    expect(editableLeaveDirection(key('Escape'))).toBeNull()
  })

  it('ignores modified arrows (editor shortcuts stay with the input)', () => {
    expect(editableLeaveDirection(key('ArrowDown', { ctrlKey: true }))).toBeNull()
    expect(editableLeaveDirection(key('ArrowUp', { altKey: true }))).toBeNull()
    expect(editableLeaveDirection(key('ArrowUp', { metaKey: true }))).toBeNull()
  })
})

describe('actionForKey', () => {
  const press = (
    k: string,
    mods: Partial<{ ctrlKey: boolean; shiftKey: boolean }> = {}
  ): KeyboardEvent => ({ ...key(k, mods), shiftKey: false, ...mods }) as unknown as KeyboardEvent

  it('maps the search keys to View (select), the options key to Y and Ctrl+arrows to section jumps', () => {
    expect(actionForKey(press('/'))).toBe('select')
    expect(actionForKey(press('F3'))).toBe('select')
    expect(actionForKey(press('F1'))).toBe('select')
    expect(actionForKey(press('f', { ctrlKey: true }))).toBe('select')
    expect(actionForKey(press('f'))).toBe('x')
    expect(actionForKey(press('ContextMenu'))).toBe('y')
    expect(actionForKey(press('F10'))).toBe('start')
    expect(actionForKey(press('ArrowUp', { ctrlKey: true }))).toBe('section-prev')
    expect(actionForKey(press('ArrowDown', { ctrlKey: true }))).toBe('section-next')
    expect(actionForKey(press('ArrowDown'))).toBe('down')
    expect(actionForKey(press('ArrowLeft', { ctrlKey: true }))).toBeNull()
    expect(actionForKey(press('PageUp'))).toBe('lt')
    expect(actionForKey(press('PageDown'))).toBe('rt')
  })
})

describe('onWindowBlurReleaseText', () => {
  it('lets go of a text field when the window loses the focus, and leaves other controls alone', () => {
    class FakeHTMLElement {
      isContentEditable = false
      blur = vi.fn()
    }
    class FakeInput extends FakeHTMLElement {
      constructor(public type: string) {
        super()
      }
    }
    class FakeTextArea extends FakeHTMLElement {}
    vi.stubGlobal('HTMLElement', FakeHTMLElement)
    vi.stubGlobal('HTMLInputElement', FakeInput)
    vi.stubGlobal('HTMLTextAreaElement', FakeTextArea)
    try {
      const search = new FakeInput('text')
      vi.stubGlobal('document', { activeElement: search })
      onWindowBlurReleaseText()
      expect(search.blur).toHaveBeenCalledTimes(1)

      const slider = new FakeInput('range')
      vi.stubGlobal('document', { activeElement: slider })
      onWindowBlurReleaseText()
      expect(slider.blur).not.toHaveBeenCalled()

      vi.stubGlobal('document', { activeElement: null })
      expect(() => onWindowBlurReleaseText()).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
