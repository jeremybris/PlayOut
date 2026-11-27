import { describe, expect, it } from 'vitest'
import { isIngameQuery } from './ingame'

describe('isIngameQuery', () => {
  it('needs both overlay=1 and ingame=1', () => {
    expect(isIngameQuery('?overlay=1&ingame=1')).toBe(true)
    expect(isIngameQuery('?ingame=1&overlay=1&mock=1')).toBe(true)
    expect(isIngameQuery('?overlay=1')).toBe(false)
    expect(isIngameQuery('?ingame=1')).toBe(false)
    expect(isIngameQuery('?overlay=1&ingame=0')).toBe(false)
    expect(isIngameQuery('')).toBe(false)
  })
})
