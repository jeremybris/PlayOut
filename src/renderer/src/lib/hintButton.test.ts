import { describe, expect, it } from 'vitest'
import { displayButton, type HintButton } from './hintButton'

const ALL: HintButton[] = [
  'a',
  'b',
  'x',
  'y',
  'lb',
  'rb',
  'lt',
  'rt',
  'start',
  'select',
  'dpad',
  'rs'
]

describe('displayButton', () => {
  it('shows the standard layout when A/B are not swapped', () => {
    for (const button of ALL) expect(displayButton(button, false)).toBe(button)
  })

  it('swaps only A and B when the Swap A and B setting is on', () => {
    expect(displayButton('a', true)).toBe('b')
    expect(displayButton('b', true)).toBe('a')
    for (const button of ALL.filter((b) => b !== 'a' && b !== 'b'))
      expect(displayButton(button, true)).toBe(button)
  })
})
