import { describe, expect, it } from 'vitest'
import { maskOf, type PadButton, type PadInfo } from '../../shared/overlay'
import { createComboCapture, createComboMatcher, validateCombo } from './combo'

function pad(id: string, ...buttons: PadButton[]): PadInfo {
  return { id, name: id, buttons: maskOf(buttons) }
}

describe('createComboMatcher', () => {
  it('fires once on the press that completes a one-button combo', () => {
    const m = createComboMatcher({ combo: ['guide'], holdMs: 0, now: () => 0 })
    expect(m.update([pad('xinput:0')], 0)).toBe(false)
    expect(m.update([pad('xinput:0', 'guide')], 10)).toBe(true)
    // Still held, or other buttons changing while held: no second fire.
    expect(m.update([pad('xinput:0', 'guide')], 20)).toBe(false)
    expect(m.update([pad('xinput:0', 'guide', 'a')], 30)).toBe(false)
    expect(m.update([pad('xinput:0', 'guide')], 40)).toBe(false)
    // Released, pressed again: fires again.
    expect(m.update([pad('xinput:0')], 50)).toBe(false)
    expect(m.update([pad('xinput:0', 'guide')], 60)).toBe(true)
  })

  it('fires a multi-button combo when the last button goes down, in any order', () => {
    const m = createComboMatcher({ combo: ['view', 'menu'], holdMs: 0 })
    m.update([pad('p')], 0)
    expect(m.update([pad('p', 'menu')], 1)).toBe(false)
    expect(m.update([pad('p', 'menu', 'view')], 2)).toBe(true)
    // Releasing one and pressing it again re-arms the combo.
    expect(m.update([pad('p', 'menu')], 3)).toBe(false)
    expect(m.update([pad('p', 'menu', 'view')], 4)).toBe(true)
  })

  it('fires when both buttons go down in the same report', () => {
    const m = createComboMatcher({ combo: ['lb', 'rb'], holdMs: 0 })
    m.update([pad('p')], 0)
    expect(m.update([pad('p', 'lb', 'rb')], 1)).toBe(true)
  })

  it('allows extra buttons held with the combo', () => {
    const m = createComboMatcher({ combo: ['guide'], holdMs: 0 })
    m.update([pad('p', 'a')], 0)
    expect(m.update([pad('p', 'a', 'guide')], 1)).toBe(true)
  })

  it('needs every button on one pad', () => {
    const m = createComboMatcher({ combo: ['view', 'menu'], holdMs: 0 })
    m.update([pad('a'), pad('b')], 0)
    expect(m.update([pad('a', 'view'), pad('b', 'menu')], 1)).toBe(false)
    expect(m.update([pad('a', 'view', 'menu'), pad('b', 'menu')], 2)).toBe(true)
  })

  it('does not fire for buttons a pad already held when first seen', () => {
    const m = createComboMatcher({ combo: ['guide'], holdMs: 0 })
    // The Guide press that turns the pad on connects it with Guide held.
    expect(m.update([pad('xinput:1', 'guide')], 0)).toBe(false)
    expect(m.update([pad('xinput:1', 'guide')], 5)).toBe(false)
    expect(m.update([pad('xinput:1')], 10)).toBe(false)
    expect(m.update([pad('xinput:1', 'guide')], 15)).toBe(true)
  })

  it('does not fire when a non-combo button completes the hold of an already held combo', () => {
    const m = createComboMatcher({ combo: ['view', 'menu'], holdMs: 0 })
    m.update([pad('p', 'view', 'menu')], 0)
    expect(m.update([pad('p', 'view', 'menu', 'a')], 1)).toBe(false)
  })

  it('forgets a pad that disconnects', () => {
    const m = createComboMatcher({ combo: ['guide'], holdMs: 0 })
    m.update([pad('p')], 0)
    expect(m.update([pad('p', 'guide')], 1)).toBe(true)
    expect(m.update([], 2)).toBe(false)
    // Back with Guide held: taken as it is (no fresh press), then a real press fires.
    expect(m.update([pad('p', 'guide')], 3)).toBe(false)
    m.update([pad('p')], 4)
    expect(m.update([pad('p', 'guide')], 5)).toBe(true)
  })

  it('fires once even when two pads complete the combo together', () => {
    const m = createComboMatcher({ combo: ['guide'], holdMs: 0 })
    m.update([pad('a'), pad('b')], 0)
    expect(m.update([pad('a', 'guide'), pad('b', 'guide')], 1)).toBe(true)
    expect(m.update([pad('a', 'guide'), pad('b', 'guide')], 2)).toBe(false)
  })

  it('never fires an empty combo', () => {
    const m = createComboMatcher({ combo: [], holdMs: 0 })
    m.update([pad('p')], 0)
    expect(m.update([pad('p', 'a', 'guide')], 1)).toBe(false)
    expect(m.pendingUntil()).toBeNull()
  })

  describe('with a hold time', () => {
    it('fires only after the combo was held long enough', () => {
      const m = createComboMatcher({ combo: ['view', 'menu'], holdMs: 500 })
      m.update([pad('p')], 0)
      expect(m.update([pad('p', 'view', 'menu')], 100)).toBe(false)
      expect(m.pendingUntil()).toBe(600)
      expect(m.update([pad('p', 'view', 'menu')], 599)).toBe(false)
      expect(m.update([pad('p', 'view', 'menu')], 600)).toBe(true)
      expect(m.pendingUntil()).toBeNull()
      expect(m.update([pad('p', 'view', 'menu')], 2000)).toBe(false)
    })

    it('starts over when a button is released before the time', () => {
      const m = createComboMatcher({ combo: ['view', 'menu'], holdMs: 500 })
      m.update([pad('p')], 0)
      m.update([pad('p', 'view', 'menu')], 100)
      expect(m.update([pad('p', 'view')], 400)).toBe(false)
      expect(m.pendingUntil()).toBeNull()
      expect(m.update([pad('p', 'view', 'menu')], 450)).toBe(false)
      expect(m.update([pad('p', 'view', 'menu')], 900)).toBe(false)
      expect(m.update([pad('p', 'view', 'menu')], 950)).toBe(true)
    })

    it('keeps the hold start while other buttons change', () => {
      const m = createComboMatcher({ combo: ['guide'], holdMs: 300 })
      m.update([pad('p')], 0)
      m.update([pad('p', 'guide')], 10)
      m.update([pad('p', 'guide', 'a')], 200)
      expect(m.pendingUntil()).toBe(310)
      expect(m.update([pad('p', 'guide', 'a')], 310)).toBe(true)
    })

    it('reports the earliest pending pad and drops a pad that leaves', () => {
      const m = createComboMatcher({ combo: ['guide'], holdMs: 300 })
      m.update([pad('a'), pad('b')], 0)
      m.update([pad('a'), pad('b', 'guide')], 50)
      m.update([pad('a', 'guide'), pad('b', 'guide')], 100)
      expect(m.pendingUntil()).toBe(350)
      m.update([pad('a', 'guide')], 120)
      expect(m.pendingUntil()).toBe(400)
    })

    it('uses the injected clock when no time is given', () => {
      let t = 0
      const m = createComboMatcher({ combo: ['guide'], holdMs: 100, now: () => t })
      m.update([pad('p')])
      t = 10
      expect(m.update([pad('p', 'guide')])).toBe(false)
      t = 110
      expect(m.update([pad('p', 'guide')])).toBe(true)
    })

    it('treats a negative or invalid hold time as none', () => {
      const m = createComboMatcher({ combo: ['guide'], holdMs: Number.NaN })
      m.update([pad('p')], 0)
      expect(m.update([pad('p', 'guide')], 1)).toBe(true)
      const n = createComboMatcher({ combo: ['guide'], holdMs: -5 })
      n.update([pad('p')], 0)
      expect(n.update([pad('p', 'guide')], 1)).toBe(true)
    })
  })
})

describe('createComboCapture', () => {
  it('records the buttons held together and finishes when all are released', () => {
    const c = createComboCapture()
    expect(c.feed([pad('p')])).toBeNull()
    expect(c.feed([pad('p', 'lb')])).toEqual({ held: ['lb'] })
    expect(c.feed([pad('p', 'lb', 'rb')])).toEqual({ held: ['lb', 'rb'] })
    // Releasing one keeps the union; nothing new to show.
    expect(c.feed([pad('p', 'rb')])).toBeNull()
    expect(c.feed([pad('p')])).toEqual({ held: ['lb', 'rb'], done: ['lb', 'rb'] })
    expect(c.finished).toBe(true)
    expect(c.feed([pad('p', 'a')])).toBeNull()
  })

  it('adds a button pressed after another was released while one is still held', () => {
    const c = createComboCapture()
    c.feed([pad('p')])
    c.feed([pad('p', 'view')])
    c.feed([pad('p', 'view', 'menu')])
    c.feed([pad('p', 'menu')])
    expect(c.feed([pad('p', 'menu', 'a')])).toEqual({ held: ['a', 'view', 'menu'] })
  })

  it('ignores a pad that starts with buttons held until it releases them', () => {
    const c = createComboCapture()
    expect(c.feed([pad('p', 'a')])).toBeNull()
    expect(c.feed([pad('p', 'a', 'b')])).toBeNull()
    expect(c.feed([pad('p')])).toBeNull()
    expect(c.feed([pad('p', 'guide')])).toEqual({ held: ['guide'] })
    expect(c.feed([pad('p')])).toEqual({ held: ['guide'], done: ['guide'] })
  })

  it('records only the pad that pressed first', () => {
    const c = createComboCapture()
    c.feed([pad('a'), pad('b')])
    expect(c.feed([pad('a', 'x'), pad('b')])).toEqual({ held: ['x'] })
    expect(c.feed([pad('a', 'x'), pad('b', 'y')])).toBeNull()
    // The other pad still holding does not keep the capture open.
    expect(c.feed([pad('a'), pad('b', 'y')])).toEqual({ held: [], done: [] })
    expect(c.rejected).toMatch(/single button/)
  })

  it('a pad connected during the capture with buttons held is ignored', () => {
    const c = createComboCapture()
    c.feed([pad('a')])
    expect(c.feed([pad('a'), pad('b', 'guide')])).toBeNull()
    expect(c.feed([pad('a', 'lb'), pad('b', 'guide')])).toEqual({ held: ['lb'] })
  })

  it('starts over when the recording pad disconnects', () => {
    const c = createComboCapture()
    c.feed([pad('a'), pad('b')])
    c.feed([pad('a', 'lb'), pad('b')])
    expect(c.feed([pad('b')])).toEqual({ held: [] })
    expect(c.feed([pad('b', 'rb')])).toEqual({ held: ['rb'] })
    expect(c.feed([pad('b', 'rb', 'lb')])).toEqual({ held: ['lb', 'rb'] })
    expect(c.feed([pad('b')])).toEqual({ held: ['lb', 'rb'], done: ['lb', 'rb'] })
  })
})

describe('combo capture limits', () => {
  it('keeps the first four buttons pressed and ignores more', () => {
    const c = createComboCapture()
    c.feed([pad('p')])
    c.feed([pad('p', 'lb')])
    c.feed([pad('p', 'lb', 'rb')])
    c.feed([pad('p', 'lb', 'rb', 'lt')])
    expect(c.feed([pad('p', 'lb', 'rb', 'lt', 'rt')])).toEqual({ held: ['lb', 'rb', 'lt', 'rt'] })
    // A fifth button changes nothing.
    expect(c.feed([pad('p', 'lb', 'rb', 'lt', 'rt', 'view')])).toBeNull()
    const end = c.feed([pad('p')])
    expect(end?.done).toEqual(['lb', 'rb', 'lt', 'rt'])
    expect(validateCombo(end!.done!)).toEqual({ ok: true })
  })

  it('caps several buttons pressed in one report at four', () => {
    const c = createComboCapture()
    c.feed([pad('p')])
    const ev = c.feed([pad('p', 'a', 'b', 'x', 'y', 'lb', 'rb')])
    expect(ev?.held).toHaveLength(4)
    expect(c.feed([pad('p')])?.done).toHaveLength(4)
  })

  it('rejects a single non-Home button (B pressed to back out) with an empty done', () => {
    const c = createComboCapture()
    c.feed([pad('p')])
    expect(c.feed([pad('p', 'b')])).toEqual({ held: ['b'] })
    expect(c.feed([pad('p')])).toEqual({ held: [], done: [] })
    expect(c.finished).toBe(true)
    expect(c.rejected).toBe(
      'A single button other than Home is used by games: hold two or more buttons together.'
    )
    expect(c.feed([pad('p', 'a')])).toBeNull()
  })

  it('accepts Guide alone', () => {
    const c = createComboCapture()
    c.feed([pad('p')])
    c.feed([pad('p', 'guide')])
    expect(c.feed([pad('p')])).toEqual({ held: ['guide'], done: ['guide'] })
    expect(c.rejected).toBeNull()
  })
})

describe('validateCombo', () => {
  it('accepts Guide alone and 2 to 4 buttons', () => {
    expect(validateCombo(['guide'])).toEqual({ ok: true })
    expect(validateCombo(['view', 'menu'])).toEqual({ ok: true })
    expect(validateCombo(['lb', 'rb', 'lt', 'rt'])).toEqual({ ok: true })
  })

  it('refuses more than 4 buttons', () => {
    expect(validateCombo(['lb', 'rb', 'lt', 'rt', 'view'])).toEqual({
      ok: false,
      reason: 'Use at most 4 buttons.'
    })
  })

  it('refuses a single button other than Home', () => {
    for (const b of ['a', 'b', 'x', 'y', 'menu'] as const) {
      expect(validateCombo([b])).toEqual({
        ok: false,
        reason:
          'A single button other than Home is used by games: hold two or more buttons together.'
      })
    }
  })

  it('refuses nothing pressed', () => {
    expect(validateCombo([]).ok).toBe(false)
  })
})
