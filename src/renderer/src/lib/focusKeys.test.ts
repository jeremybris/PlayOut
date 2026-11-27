import { describe, expect, it } from 'vitest'
import {
  addGamesTileFocusKey,
  cardFocusKey,
  downloadQueueAllKey,
  downloadQueueEmptyKey,
  downloadQueueRowKey,
  downloadQueueSafeFocusKey,
  parseCardFocusKey,
  rowFocusKey
} from './focusKeys'

describe('focus keys', () => {
  it('builds card, tile and row keys', () => {
    expect(cardFocusKey('recent', 'steam:620')).toBe('card:recent:steam:620')
    expect(addGamesTileFocusKey('recent')).toBe('card:recent:add-games')
    expect(rowFocusKey('platform:steam')).toBe('row:platform:steam')
  })
  it('parses card keys for plain and platform rows', () => {
    expect(parseCardFocusKey('card:recent:steam:620')).toEqual({
      rowId: 'recent',
      gameId: 'steam:620'
    })
    expect(parseCardFocusKey('card:platform:snes:rom:snes:abc')).toEqual({
      rowId: 'platform:snes',
      gameId: 'rom:snes:abc'
    })
    expect(parseCardFocusKey('card:search:epic:fortnite')).toEqual({
      rowId: 'search',
      gameId: 'epic:fortnite'
    })
    expect(parseCardFocusKey('row:recent')).toBeNull()
    expect(parseCardFocusKey(null)).toBeNull()
    expect(parseCardFocusKey('card:')).toBeNull()
  })
})

describe('download queue focus keys', () => {
  it("lands on the first row's title (no action), never a button, so A after opening stops nothing", () => {
    expect(downloadQueueRowKey('quickpanel:downloads', 'steam:620', 'remove')).toBe(
      'quickpanel:downloads:steam:620:remove'
    )
    expect(
      downloadQueueSafeFocusKey('quickpanel:downloads', [{ gameId: 'a' }, { gameId: 'b' }])
    ).toBe('quickpanel:downloads:a:info')
  })

  it('is undefined for an empty queue (the opener falls back to its own default)', () => {
    expect(downloadQueueSafeFocusKey('quickpanel:downloads', [])).toBeUndefined()
    // The empty list's own focus stop never collides with a row key (game ids carry a source prefix).
    expect(downloadQueueEmptyKey('overlay:downloads')).toBe('overlay:downloads:empty')
    expect(downloadQueueAllKey('overlay:downloads')).toBe('overlay:downloads:pause-all')
  })
})
