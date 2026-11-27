import { describe, expect, it } from 'vitest'
import { getIniValue, iniIsEmpty, setIniValue } from './ini'

const HOOKING = '[Hooking]\r\nUseDetours=1\r\n'

describe('setIniValue', () => {
  it('creates a new file as RTSS writes them (CRLF)', () => {
    expect(setIniValue(null, 'Framerate', 'Limit', '60')).toBe('[Framerate]\r\nLimit=60\r\n')
    expect(setIniValue('', 'Hooking', 'EnableHooking', '0')).toBe(
      '[Hooking]\r\nEnableHooking=0\r\n'
    )
  })

  it('adds a missing section at the end and keeps every other line', () => {
    expect(setIniValue(HOOKING, 'Framerate', 'Limit', '60')).toBe(
      '[Hooking]\r\nUseDetours=1\r\n[Framerate]\r\nLimit=60\r\n'
    )
  })

  it('replaces a key in place, case-insensitively, keeping its spelling and the order', () => {
    const text =
      '[OSD]\r\nEnableOSD=1\r\n[Framerate]\r\nlimit = 30\r\nLimitDenominator=1\r\n[Hooking]\r\nX=1\r\n'
    expect(setIniValue(text, 'framerate', 'Limit', '90')).toBe(
      '[OSD]\r\nEnableOSD=1\r\n[Framerate]\r\nlimit=90\r\nLimitDenominator=1\r\n[Hooking]\r\nX=1\r\n'
    )
  })

  it("inserts a missing key after the section's last setting, before blank lines", () => {
    const text = '[Framerate]\nLimitDenominator=1\n\n[Hooking]\nX=1'
    expect(setIniValue(text, 'Framerate', 'Limit', '45')).toBe(
      '[Framerate]\nLimitDenominator=1\nLimit=45\n\n[Hooking]\nX=1'
    )
    expect(setIniValue('[Framerate]\r\n', 'Framerate', 'Limit', '45')).toBe(
      '[Framerate]\r\nLimit=45\r\n'
    )
  })

  it('removes the key with null, and changes nothing when it is not there', () => {
    const text =
      '[Framerate]\r\nLimit=60\r\n; Limit=1 comment\r\nLimit=70\r\n[Other]\r\nLimit=5\r\n'
    expect(setIniValue(text, 'Framerate', 'Limit', null)).toBe(
      '[Framerate]\r\n; Limit=1 comment\r\n[Other]\r\nLimit=5\r\n'
    )
    expect(setIniValue(HOOKING, 'Framerate', 'Limit', null)).toBe(HOOKING)
    expect(setIniValue(HOOKING, 'Hooking', 'Nope', null)).toBe(HOOKING)
  })

  it('returns the text itself when the value is already set', () => {
    const text = '[Hooking]\nEnableHooking=0'
    expect(setIniValue(text, 'Hooking', 'EnableHooking', '0')).toBe(text)
  })
})

describe('getIniValue / iniIsEmpty', () => {
  it('reads the first value of a section', () => {
    expect(getIniValue('[Framerate]\r\nLimit = 72 \r\nLimit=5', 'Framerate', 'Limit')).toBe('72')
    expect(getIniValue(HOOKING, 'Framerate', 'Limit')).toBeNull()
    expect(getIniValue('[Hooking]\r\nLimit=1', 'Framerate', 'Limit')).toBeNull()
    expect(getIniValue(null, 'Framerate', 'Limit')).toBeNull()
  })

  it('is empty with only section headers and blank lines', () => {
    expect(iniIsEmpty(null)).toBe(true)
    expect(iniIsEmpty('[Framerate]\r\n\r\n')).toBe(true)
    expect(iniIsEmpty('[Framerate]\r\nLimit=0\r\n')).toBe(false)
    expect(iniIsEmpty(HOOKING)).toBe(false)
  })
})
