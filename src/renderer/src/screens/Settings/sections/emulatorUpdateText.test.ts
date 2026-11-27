import { describe, expect, it } from 'vitest'
import { updateLine, updateSummary } from './emulatorUpdateText'

const item = { id: 'DOLPHIN', name: 'Dolphin' }

describe('updateLine', () => {
  it('says what changed, with the channel', () => {
    expect(
      updateLine({ ...item, result: 'updated', from: '2509', to: '2512-41', channel: 'dev' }).text
    ).toBe('Updated from 2509 to 2512-41 (dev)')
  })
  it('cuts long versions and leaves the stable channel out', () => {
    const line = updateLine({
      ...item,
      result: 'current',
      to: '0123456789abcdef0123456789abcdef',
      channel: 'stable'
    })
    expect(line.text).toBe('Up to date: 0123456789abcdef0123456…')
  })
  it('warns about open and failed emulators', () => {
    expect(updateLine({ ...item, result: 'running' }).tone).toBe('warn')
    expect(updateLine({ ...item, result: 'failed', error: 'offline' }).text).toBe(
      'Could not be updated: offline (the installed build is kept)'
    )
  })
})

describe('updateSummary', () => {
  it('counts each outcome', () => {
    expect(
      updateSummary({
        at: '',
        items: [
          { ...item, result: 'updated' },
          { ...item, result: 'updated' },
          { ...item, result: 'current' },
          { ...item, result: 'running' },
          { ...item, result: 'unavailable' }
        ]
      })
    ).toEqual({
      text: '2 emulators updated · 1 already up to date · 1 open, left alone',
      tone: 'success'
    })
  })
  it('is a warning when one failed', () => {
    expect(updateSummary({ at: '', items: [{ ...item, result: 'failed' }] }).tone).toBe('warning')
  })
  it('says when nothing has a newer build', () => {
    expect(updateSummary({ at: '', items: [{ ...item, result: 'unavailable' }] }).text).toBe(
      'No emulator has a newer build'
    )
  })
})
