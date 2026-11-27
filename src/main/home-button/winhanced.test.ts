import { describe, expect, it } from 'vitest'
import { detectWinhanced, parseWinhancedSettings, winhancedClash } from './winhanced'
import { createFakeWindows } from './testing'

const THIS_PC = parseWinhancedSettings(
  JSON.stringify({
    RemapGuideButton: false,
    UseInAppOverlay: false,
    GuideButtonOpensOverlay: false,
    StartSelectOpensGameBar: true
  })
)

describe('parseWinhancedSettings', () => {
  it('reads the four flags', () => {
    expect(
      parseWinhancedSettings(
        '\uFEFF{"StartSelectOpensGameBar":false,"GuideButtonOpensOverlay":true,"RemapGuideButton":true,"UseInAppOverlay":true}'
      )
    ).toEqual({
      startSelectOpensGameBar: false,
      guideButtonOpensOverlay: true,
      remapGuideButton: true,
      useInAppOverlay: true
    })
  })

  it("falls back to Winhanced's defaults (View + Menu on)", () => {
    const defaults = {
      startSelectOpensGameBar: true,
      guideButtonOpensOverlay: false,
      remapGuideButton: false,
      useInAppOverlay: false
    }
    expect(parseWinhancedSettings(null)).toEqual(defaults)
    expect(parseWinhancedSettings('{oops')).toEqual(defaults)
    expect(parseWinhancedSettings('{"StartSelectOpensGameBar":null}')).toEqual(defaults)
  })
})

describe('winhancedClash', () => {
  it('has no clash for the default Guide combo on this PC', () => {
    expect(winhancedClash(['guide'], THIS_PC)).toBeUndefined()
  })

  it('warns when the combo overlaps View + Menu', () => {
    expect(winhancedClash(['view', 'menu'], THIS_PC)).toMatch(/opens Game Bar with View \+ Menu/)
    expect(winhancedClash(['menu'], THIS_PC)).toBeDefined()
    expect(winhancedClash(['view', 'menu', 'a'], THIS_PC)).toBeDefined()
    expect(winhancedClash(['menu', 'a'], THIS_PC)).toBeUndefined()
    expect(winhancedClash([], THIS_PC)).toBeUndefined()
    expect(winhancedClash(['view', 'menu'], { ...THIS_PC, useInAppOverlay: true })).toMatch(
      /opens its overlay/
    )
    expect(
      winhancedClash(['view', 'menu'], { ...THIS_PC, startSelectOpensGameBar: false })
    ).toBeUndefined()
  })

  it('warns about Guide when Winhanced takes it', () => {
    const guide = { ...THIS_PC, guideButtonOpensOverlay: true }
    expect(winhancedClash(['guide'], guide)).toMatch(/Home button/)
    expect(winhancedClash(['guide', 'a'], { ...THIS_PC, remapGuideButton: true })).toMatch(
      /Home button/
    )
    expect(winhancedClash(['lb', 'rb'], guide)).toBeUndefined()
  })
})

describe('detectWinhanced', () => {
  it('is null when Winhanced does not run, without reading its settings', async () => {
    const w = createFakeWindows()
    w.processes.add('explorer.exe')
    expect(await detectWinhanced(w.io)).toBeNull()
  })

  it('reads its settings when it runs', async () => {
    const w = createFakeWindows()
    w.processes.add('WHService.exe')
    w.setText(
      'C:\\Users\\u\\AppData\\Local\\Winhanced\\appsettings.json',
      '{"StartSelectOpensGameBar":false,"GuideButtonOpensOverlay":true}'
    )
    expect(await detectWinhanced(w.io)).toMatchObject({
      startSelectOpensGameBar: false,
      guideButtonOpensOverlay: true
    })
    w.files.clear()
    expect((await detectWinhanced(w.io))?.startSelectOpensGameBar).toBe(true)
  })
})
