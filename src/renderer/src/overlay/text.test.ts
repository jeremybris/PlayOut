import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/defaults'
import type { DisplayMode, PerformanceStatus, WattsBackendStatus } from '@shared/overlay'
import {
  appName,
  captureNotice,
  comboProblem,
  comboText,
  cpuBoostDetail,
  enduranceDetail,
  enduranceValue,
  fitWatts,
  formatFrameLimit,
  fpsChip,
  fpsChipTitle,
  frameLimitDetail,
  perfOverlayDetail,
  perfOverlayLabel,
  syncDetail,
  wattsChip,
  formatHz,
  formatResolution,
  formatWatts,
  PROFILE_WATTS_MAX,
  singleButtonComboText,
  memoryPercent,
  overrideText,
  profileChip,
  profileDetail,
  readerText,
  refreshOptions,
  resolutionOptions,
  setBoostWatts,
  setSustainedWatts,
  wattsBackendText,
  wattsRange,
  wattsReady,
  withWatts
} from './text'

const profiles = defaultSettings().performance.profiles
const ready: WattsBackendStatus = { state: 'ready', method: 'ryzenadj', minWatts: 5, maxWatts: 30 }

describe('overlay text', () => {
  it('names a combo with the pad labels', () => {
    expect(comboText(['guide'])).toBe('Home (Guide / PS)')
    expect(comboText(['view', 'menu'])).toBe('View + Menu')
    expect(comboText([])).toBe('Not set')
  })

  it('shows watts under a profile only when the helper is ready and the profile sets them', () => {
    expect(profileDetail('silent', profiles.silent, true)).toBe('Quiet')
    const withLimits = { ...profiles.custom, watts: 12, boostWatts: 18 }
    expect(profileDetail('custom', withLimits, true)).toBe('12/18 W')
    expect(profileDetail('custom', { ...withLimits, boostWatts: null }, true)).toBe('12 W')
    expect(profileDetail('custom', withLimits, false)).toBe('Your own')
    expect(profileDetail('none', undefined, true)).toBe('Windows')
    expect(formatWatts(7.25)).toBe('7.3 W')
  })

  it('needs both the ready helper and the setting for watts', () => {
    expect(wattsReady(ready, true)).toBe(true)
    expect(wattsReady(ready, false)).toBe(false)
    expect(wattsReady({ state: 'not-installed' }, true)).toBe(false)
    expect(wattsReady(undefined, true)).toBe(false)
  })

  it('writes the header chip from the profile in effect', () => {
    const status: PerformanceStatus = { active: 'balanced', source: 'default', watts: ready }
    expect(profileChip(null, profiles, true)).toBe('…')
    expect(profileChip({ ...status, active: null }, profiles, true)).toBe('Windows')
    expect(profileChip(status, profiles, true)).toBe('Balanced')
    expect(profileChip({ ...status, watts: { ...ready, currentWatts: 14 } }, profiles, true)).toBe(
      'Balanced · 14 W'
    )
    expect(profileChip({ ...status, watts: { ...ready, currentWatts: 14 } }, profiles, false)).toBe(
      'Balanced'
    )
  })

  it('explains the watts backend in one line', () => {
    expect(wattsBackendText(ready)).toBe('Power helper ready (AMD Ryzen, 5 W to 30 W).')
    expect(wattsBackendText({ state: 'not-installed', method: 'intel-msr' })).toContain('(Intel)')
    expect(wattsBackendText({ state: 'error', message: 'no answer' })).toBe(
      'The power helper is not working: no answer'
    )
    expect(wattsBackendText(undefined)).toBe('Checking…')
  })

  it('explains the overrides and the reader', () => {
    expect(overrideText('steam', { state: 'pending' })).toBe('Waiting for Steam to close…')
    expect(overrideText('gameBar', { state: 'missing' })).toBe('Game Bar is not installed.')
    expect(overrideText('steam', { state: 'error', message: 'Access denied.' })).toBe(
      'Could not change Steam. Access denied.'
    )
    expect(readerText({ reader: { state: 'running' }, pads: [] })).toBe(
      'Reading controllers. None connected.'
    )
    expect(
      readerText({
        reader: { state: 'running' },
        pads: [{ id: 'xinput:0', name: 'Xbox Wireless Controller', buttons: 0 }]
      })
    ).toBe('Reading controllers: Xbox Wireless Controller.')
    expect(
      readerText({ reader: { state: 'unavailable', message: 'no PowerShell' }, pads: [] })
    ).toBe('The controller reader is not available: no PowerShell')
  })

  it('lists the refresh rates of the current resolution and one mode per resolution', () => {
    const modes: DisplayMode[] = [
      { width: 1920, height: 1080, hz: 60 },
      { width: 1920, height: 1080, hz: 120 },
      { width: 1920, height: 1080, hz: 119.88 },
      { width: 1280, height: 720, hz: 60 },
      { width: 1280, height: 720, hz: 120 },
      { width: 800, height: 600, hz: 60 }
    ]
    const current = { width: 1920, height: 1080, hz: 120 }
    expect(refreshOptions(modes, current).map((m) => m.hz)).toEqual([120, 60])
    expect(resolutionOptions(modes, current).map((m) => [m.width, m.hz])).toEqual([
      [1920, 120],
      [1280, 120],
      [800, 60]
    ])
    expect(formatResolution(current)).toBe('1920 × 1080')
    expect(formatHz(59.94)).toBe('60 Hz')
  })

  it('works out memory use', () => {
    const sample = { cpuPercent: 1, gpuPercent: null, updatedAt: '' }
    expect(memoryPercent({ ...sample, memoryUsedMb: 4096, memoryTotalMb: 16384 })).toBe(25)
    expect(memoryPercent({ ...sample, memoryUsedMb: null, memoryTotalMb: 16384 })).toBeNull()
    expect(memoryPercent(null)).toBeNull()
  })

  it('turns watts on inside the range and keeps boost at or above sustained', () => {
    const range = wattsRange(ready)
    expect(range).toEqual({ min: 5, max: 30 })
    expect(wattsRange({ state: 'ready' })).toEqual({ min: 5, max: 30 })
    const on = withWatts(profiles.custom, true, range)
    expect(on.watts).toBe(18)
    expect(on.boostWatts).toBe(23)
    expect(withWatts(on, false, range)).toMatchObject({ watts: null, boostWatts: null })
    expect(setSustainedWatts(on, 25).boostWatts).toBe(25)
    expect(setBoostWatts(on, 10).boostWatts).toBe(18)
  })

  it('keeps watts inside the settings schema (at most 200 W) on a high-TDP desktop CPU', () => {
    // Intel without a PL max: TDP 125 W x 2.5 = 312 W.
    const range = wattsRange({ state: 'ready', method: 'intel-msr', minWatts: 5, maxWatts: 312 })
    expect(range).toEqual({ min: 5, max: PROFILE_WATTS_MAX })
    const on = withWatts(profiles.custom, true, range)
    expect(on.watts).toBeLessThanOrEqual(200)
    expect(on.boostWatts).toBeLessThanOrEqual(200)
    expect(on.boostWatts).toBeGreaterThanOrEqual(on.watts!)
    expect(wattsRange({ state: 'ready', minWatts: 250, maxWatts: 400 })).toEqual({
      min: 199,
      max: 200
    })
    expect(wattsRange({ state: 'ready', minWatts: 1, maxWatts: 30 }).min).toBe(3)
    expect(fitWatts({ ...profiles.custom, watts: 159, boostWatts: 206.4 })).toMatchObject({
      watts: 159,
      boostWatts: 200
    })
    expect(fitWatts({ ...profiles.custom, watts: null, boostWatts: null })).toMatchObject({
      watts: null,
      boostWatts: null
    })
  })

  it('accepts 1-4 buttons as the home combo, and a single button only when it is Home', () => {
    expect(comboProblem(['guide'])).toBeNull()
    expect(comboProblem(['view', 'menu'])).toBeNull()
    expect(comboProblem(['lb', 'rb', 'lt', 'rt'])).toBeNull()
    expect(comboProblem([])).not.toBeNull()
    expect(comboProblem(['b'])).toBe(singleButtonComboText())
    expect(comboProblem(['a'])).toBe(singleButtonComboText())
    expect(comboProblem(['lb', 'rb', 'lt', 'rt', 'view'])).toMatch(/at most 4/)
    expect(comboProblem(['a', 'a'])).not.toBeNull()
  })

  it('explains a capture that ended without a combo only when buttons were held', () => {
    // done: [] after B alone: the main process rejected it.
    expect(captureNotice([], 1)).toBe(singleButtonComboText())
    // Nothing pressed: a plain cancel.
    expect(captureNotice([], 0)).toBeUndefined()
    expect(captureNotice([], 5)).toMatch(/at most 4/)
    expect(captureNotice([], 2)).toBeTruthy()
    // An older main process that still sends the single button: refused here too.
    expect(captureNotice(['b'], 1)).toBe(singleButtonComboText())
  })

  it('reads an app name from its id', () => {
    expect(appName('Spotify.exe')).toBe('Spotify')
    expect(appName('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify')).toBe('Spotify')
    expect(appName('C:\\Program Files\\VLC\\vlc.exe')).toBe('vlc')
  })
})

describe('overlay extras text', () => {
  const available = { available: true, fps: 60, chosen: 60, options: [0, 60], exe: 'Game.exe' }
  const sync = { enabled: false, available: true, hz: 144 }

  it('writes frame limits and performance overlay levels', () => {
    expect(formatFrameLimit(0)).toBe('∞')
    expect(formatFrameLimit(60)).toBe('60 FPS')
    expect(perfOverlayLabel(0)).toBe('Off')
    expect(perfOverlayLabel(3)).toBe('Level 3')
    expect(perfOverlayDetail(0)).toBeUndefined()
    expect(perfOverlayDetail(1)).toBe('FPS')
    expect(perfOverlayDetail(2)).toBe('FPS, frame time, CPU, GPU, watts')
    expect(perfOverlayDetail(3)).toBe('Level 2 plus RAM, battery and time')
  })

  it('shows the live watts, else the ready backend’s, and hides when unknown', () => {
    const status: PerformanceStatus = {
      active: 'balanced',
      source: 'default',
      watts: { ...ready, currentWatts: 14.6 }
    }
    const live = { fps: null, fpsSource: null, watts: 9 } as const
    expect(wattsChip(live, status)).toBe('9 W')
    expect(wattsChip({ ...live, watts: null }, status)).toBe('15 W')
    expect(
      wattsChip(null, { ...status, dynamic: { targetFps: 60, state: 'holding', watts: 11 } })
    ).toBe('11 W')
    expect(wattsChip(null, { ...status, watts: { state: 'not-installed' } })).toBeNull()
    expect(wattsChip(null, null)).toBeNull()
  })

  it('shows the frame rate chip only with a reading, and names its source', () => {
    expect(fpsChip({ fps: 119.6, fpsSource: 'rtss', watts: null })).toBe('120 FPS')
    expect(fpsChip({ fps: null, fpsSource: null, watts: 12 })).toBeNull()
    expect(fpsChip(null)).toBeNull()
    expect(fpsChipTitle({ fps: 60, fpsSource: 'rtss', watts: null })).toMatch(/RivaTuner/)
    expect(fpsChipTitle({ fps: 60, fpsSource: 'presentmon', watts: null })).toMatch(/Dynamic TDP/)
    expect(fpsChipTitle(null)).toBe('Frame rate')
  })

  it('details the frame limit and sync tiles: reason, followed display, program', () => {
    expect(frameLimitDetail({ frameLimit: available, sync })).toBe('Game.exe')
    expect(frameLimitDetail({ frameLimit: available, sync: { ...sync, enabled: true } })).toBe(
      'Follows the display (144 Hz)'
    )
    const blocked = { ...available, available: false, reason: 'Start a game first' }
    expect(frameLimitDetail({ frameLimit: blocked, sync: { ...sync, enabled: true } })).toBe(
      'Start a game first'
    )
    expect(syncDetail({ ...sync, enabled: true })).toBe('Limit = 144 Hz')
    expect(syncDetail({ ...sync, available: false, reason: 'No RTSS' })).toBe('No RTSS')
  })

  it('details the CPU boost tile with the profile it changes or why it cannot', () => {
    expect(
      cpuBoostDetail({ enabled: true, available: true, profile: 'balanced', overridden: true })
    ).toBe('Balanced (changed)')
    expect(
      cpuBoostDetail({ enabled: false, available: true, profile: 'custom', overridden: false })
    ).toBe('Custom')
    expect(
      cpuBoostDetail({
        enabled: false,
        available: false,
        reason: 'Managed by Dynamic TDP',
        profile: 'dynamic',
        overridden: false
      })
    ).toBe('Managed by Dynamic TDP')
  })
})

describe('Endurance Gaming tile text', () => {
  const options = [
    { key: 'off', label: 'Off' },
    { key: 'auto:balanced', label: 'Auto, balanced' }
  ]
  it('shows the driver label of the current value', () => {
    expect(enduranceValue({ supported: true, value: 'auto:balanced', options })).toBe(
      'Auto, balanced'
    )
    expect(enduranceValue({ supported: true, value: 'off', options: [] })).toBe('Off')
    expect(enduranceValue({ supported: false, value: null, options: [] })).toBe('—')
  })
  it('says why it cannot act, else what it does', () => {
    expect(enduranceDetail({ supported: false, value: null, options: [], reason: 'Nope' })).toBe(
      'Nope'
    )
    expect(enduranceDetail({ supported: true, value: 'off', options })).toMatch(/battery/)
  })
})
