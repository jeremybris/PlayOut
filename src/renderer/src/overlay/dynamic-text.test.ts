import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/defaults'
import type { PerformanceStatus, WattsBackendStatus } from '@shared/overlay'
import {
  defaultProfileOptions,
  DEFAULT_PROFILE_OPTIONS,
  targetFpsOptions,
  wattsBoundOptions
} from './options'
import {
  clampTargetFps,
  dynamicAvailable,
  dynamicReadout,
  effectiveDefaultProfile,
  HELPER_PROFILE_CHOICES,
  PROFILE_CHOICES,
  profileChip,
  profileChoices,
  profileDetail,
  shownChoice
} from './text'

const profiles = defaultSettings().performance.profiles
const ready: WattsBackendStatus = { state: 'ready', method: 'ryzen-smu', minWatts: 5, maxWatts: 30 }

describe('Dynamic TDP in the overlay', () => {
  it('shows Dynamic (first), Custom watts and Off only with a ready helper, else the fallback profiles', () => {
    expect(profileChoices('ready')).toEqual(['dynamic', 'custom', 'none'])
    expect(profileChoices('ready')).toBe(HELPER_PROFILE_CHOICES)
    for (const h of ['outdated', 'missing', 'none', undefined] as const) {
      expect(profileChoices(h)).toBe(PROFILE_CHOICES)
      expect(dynamicAvailable(h)).toBe(false)
    }
    expect(PROFILE_CHOICES).not.toContain('dynamic')
    expect(defaultProfileOptions('ready').map((o) => o.label)).toEqual([
      'Dynamic TDP',
      'Custom watts',
      'Off (Windows as it is)'
    ])
    expect(defaultProfileOptions('missing')).toEqual(DEFAULT_PROFILE_OPTIONS)
    expect(DEFAULT_PROFILE_OPTIONS.map((o) => o.value)).toEqual([
      'silent',
      'balanced',
      'performance',
      'custom',
      'none'
    ])
  })

  it('never shows a fallback profile with a ready helper: one saved or in effect shows as Dynamic', () => {
    for (const c of ['silent', 'balanced', 'performance'] as const) {
      expect(shownChoice(c, 'ready')).toBe('dynamic')
      expect(shownChoice(c, 'missing')).toBe(c)
      expect(effectiveDefaultProfile(c, 'ready')).toBe('dynamic')
      expect(effectiveDefaultProfile(c, 'outdated')).toBe(c)
    }
    for (const c of ['custom', 'dynamic', 'none'] as const) expect(shownChoice(c, 'ready')).toBe(c)
    expect(shownChoice(undefined, 'ready')).toBeUndefined()
    // The value shown is always one of the options offered.
    for (const v of [
      'auto',
      'silent',
      'balanced',
      'performance',
      'custom',
      'dynamic',
      'none'
    ] as const)
      expect(defaultProfileOptions('ready').map((o) => o.value)).toContain(
        effectiveDefaultProfile(v, 'ready')
      )
    expect(defaultProfileOptions('ready').some((o) => /legacy/i.test(o.label))).toBe(false)
  })

  it("reads the factory default 'auto' as Dynamic with the helper and Off without", () => {
    expect(effectiveDefaultProfile('auto', 'ready')).toBe('dynamic')
    expect(effectiveDefaultProfile('auto', 'missing')).toBe('none')
    expect(effectiveDefaultProfile('dynamic', 'ready')).toBe('dynamic')
    expect(effectiveDefaultProfile('dynamic', 'outdated')).toBe('balanced')
    expect(effectiveDefaultProfile('none', 'ready')).toBe('none')
  })

  it('writes the live readout, the card detail and the header chip', () => {
    expect(dynamicReadout(undefined)).toBe('')
    expect(dynamicReadout({ targetFps: 60, state: 'idle' })).toBe(
      'Starts with a game · target 60 fps'
    )
    expect(dynamicReadout({ targetFps: 60, state: 'measuring', watts: 18 })).toBe(
      'Measuring… · 18 W'
    )
    expect(dynamicReadout({ targetFps: 60, state: 'holding', fps: 58.4, watts: 14 })).toBe(
      '58 fps · 14 W'
    )
    expect(dynamicReadout({ targetFps: 60, state: 'plateau', fps: 45, watts: 22 })).toBe(
      '45 fps · 22 W · more watts would not help'
    )
    expect(dynamicReadout({ targetFps: 60, state: 'no-fps', watts: 18 })).toBe(
      'No frames measured · 18 W'
    )
    expect(profileDetail('dynamic', undefined, true, 60)).toBe('60 fps')
    expect(profileDetail('dynamic', undefined, true)).toBe('Holds the FPS')
    const status: PerformanceStatus = {
      active: 'dynamic',
      source: 'default',
      watts: ready,
      helper: 'ready',
      dynamic: { targetFps: 60, state: 'holding', fps: 59, watts: 14 }
    }
    expect(profileChip(status, profiles, true)).toBe('Dynamic · 60 fps')
  })

  it('offers target presets and watts bounds as select options', () => {
    expect(targetFpsOptions(60).map((o) => o.value)).toEqual(['30', '40', '45', '60', '90', '120'])
    expect(targetFpsOptions(75).map((o) => o.value)).toContain('75')
    expect(clampTargetFps(500)).toBe(240)
    expect(clampTargetFps(10)).toBe(20)
    expect(clampTargetFps(59.6)).toBe(60)
    const bounds = wattsBoundOptions({ min: 5, max: 28 }, 12)
    expect(bounds.map((o) => o.value)).toEqual(['none', '5', '10', '12', '15', '20', '25'])
    expect(bounds[0]!.label).toBe('No limit')
  })
})
