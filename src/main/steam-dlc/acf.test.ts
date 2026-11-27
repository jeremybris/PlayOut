import { describe, expect, it } from 'vitest'
import {
  acfShowsDownload,
  isDownloading,
  parseIdList,
  readAcfDlc,
  writeUserDisabledDlc
} from './acf'

// The shape of TowerFall's manifest on the test PC (2026-11-15), DLC 337840 installed and turned off.
const ACF = [
  '"AppState"',
  '{',
  '\t"appid"\t\t"251470"',
  '\t"name"\t\t"TowerFall Ascension"',
  '\t"StateFlags"\t\t"4"',
  '\t"installdir"\t\t"TowerFall"',
  '\t"InstalledDepots"',
  '\t{',
  '\t\t"251471"',
  '\t\t{',
  '\t\t\t"manifest"\t\t"123"',
  '\t\t\t"size"\t\t"1000"',
  '\t\t}',
  '\t\t"337841"',
  '\t\t{',
  '\t\t\t"manifest"\t\t"456"',
  '\t\t\t"size"\t\t"200"',
  '\t\t\t"dlcappid"\t\t"337840"',
  '\t\t}',
  '\t}',
  '\t"UserConfig"',
  '\t{',
  '\t\t"DisabledDLC"\t\t"337840,400"',
  '\t\t"language"\t\t"english"',
  '\t}',
  '\t"MountedConfig"',
  '\t{',
  '\t\t"DisabledDLC"\t\t"400"',
  '\t\t"language"\t\t"english"',
  '\t}',
  '}',
  ''
].join('\r\n')

describe('parseIdList', () => {
  it('reads a comma list, dropping junk and repeats', () => {
    expect(parseIdList('1, 2,2,x,,-3,4.5,7')).toEqual([1, 2, 7])
    expect(parseIdList(undefined)).toEqual([])
    expect(parseIdList('')).toEqual([])
  })
})

describe('readAcfDlc', () => {
  it('reads both DisabledDLC lists and the installed DLC', () => {
    expect(readAcfDlc(ACF)).toEqual({
      appId: 251470,
      stateFlags: 4,
      userDisabled: [337840, 400],
      mountedDisabled: [400],
      installedDlc: [337840]
    })
  })

  it('reads a manifest without DLC keys as nothing turned off', () => {
    const text =
      '"AppState"\n{\n\t"appid"\t\t"10"\n\t"UserConfig"\n\t{\n\t\t"language"\t\t"english"\n\t}\n}\n'
    expect(readAcfDlc(text)).toMatchObject({
      userDisabled: [],
      mountedDisabled: [],
      installedDlc: []
    })
  })

  it('throws on a file that is not a manifest', () => {
    expect(() => readAcfDlc('"Other"\n{\n}\n')).toThrow()
    expect(() => readAcfDlc('"AppState"\n{\n\t"appid" "1')).toThrow()
  })
})

describe('writeUserDisabledDlc', () => {
  it('replaces only the UserConfig value and keeps every other byte', () => {
    const { text, changed } = writeUserDisabledDlc(ACF, [500, 337840])
    expect(changed).toBe(true)
    expect(text).toBe(ACF.replace('"DisabledDLC"\t\t"337840,400"', '"DisabledDLC"\t\t"500,337840"'))
    // MountedConfig is Steam's own record.
    expect(readAcfDlc(text).mountedDisabled).toEqual([400])
  })

  it('removes the key (its whole line) for an empty list', () => {
    const { text, changed } = writeUserDisabledDlc(ACF, [])
    expect(changed).toBe(true)
    expect(text).toBe(ACF.replace('\t\t"DisabledDLC"\t\t"337840,400"\r\n', ''))
    expect(readAcfDlc(text).mountedDisabled).toEqual([400])
  })

  it('adds the key to UserConfig when it is missing there', () => {
    const without = writeUserDisabledDlc(ACF, []).text
    const { text } = writeUserDisabledDlc(without, [337840])
    expect(readAcfDlc(text)).toMatchObject({ userDisabled: [337840], mountedDisabled: [400] })
    expect(text).toContain(
      '\t"UserConfig"\r\n\t{\r\n\t\t"DisabledDLC"\t\t"337840"\r\n\t\t"language"'
    )
  })

  it('creates the UserConfig block when the manifest has none', () => {
    const text = '"AppState"\n{\n\t"appid"\t\t"10"\n}\n'
    const out = writeUserDisabledDlc(text, [3, 2]).text
    expect(out).toBe(
      '"AppState"\n{\n\t"UserConfig"\n\t{\n\t\t"DisabledDLC"\t\t"2,3"\n\t}\n\t"appid"\t\t"10"\n}\n'
    )
    expect(readAcfDlc(out).userDisabled).toEqual([2, 3])
  })

  it('reports no change when the list is the same', () => {
    expect(writeUserDisabledDlc(ACF, [400, 337840])).toEqual({ text: ACF, changed: false })
    const none = '"AppState"\n{\n\t"appid"\t\t"10"\n}\n'
    expect(writeUserDisabledDlc(none, [])).toEqual({ text: none, changed: false })
  })
})

describe('download state', () => {
  it('counts running bits, not a paused or merely required update', () => {
    expect(isDownloading(4)).toBe(false)
    expect(isDownloading(6)).toBe(false)
    expect(isDownloading(1030)).toBe(true)
    expect(isDownloading(1026 | 4 | 512)).toBe(false)
    expect(isDownloading(4 | 1048576)).toBe(true)
  })

  it('reads StateFlags from the text', () => {
    expect(acfShowsDownload(ACF)).toBe(false)
    expect(acfShowsDownload(ACF.replace('"StateFlags"\t\t"4"', '"StateFlags"\t\t"1542"'))).toBe(
      false
    )
    expect(acfShowsDownload(ACF.replace('"StateFlags"\t\t"4"', '"StateFlags"\t\t"1030"'))).toBe(
      true
    )
    expect(acfShowsDownload('garbage')).toBe(false)
  })
})
