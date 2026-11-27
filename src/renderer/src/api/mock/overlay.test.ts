import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryStatus } from '@shared/memory'
import type { ComboCaptureEvent, OverlayState } from '@shared/overlay'
import { createMockApi } from './index'
import type { OverlayExtrasStatus } from '@shared/overlay-extras'
import { MOCK_MEMORY_PASS_MS, MOCK_MUSIC_FOLDER, mockGameExe } from './overlay'

function storageStub(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, String(value))
  }
}

describe('mock overlay api', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', storageStub())
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('overlay=1 starts open over a running game, and Quit game ends it and closes', async () => {
    const api = createMockApi({ search: '?mock=1&overlay=1' })
    const state = await api.getOverlayState()
    expect(state.open).toBe(true)
    const running = await api.getRunningGame()
    expect(running?.gameId).toBe(state.gameId)

    const states: OverlayState[] = []
    api.on('overlay:state', (s) => states.push(s))
    expect(await api.quitRunningGame()).toBe(true)
    expect(await api.getRunningGame()).toBeNull()
    expect(states.at(-1)).toEqual({ open: false })
  })

  it('records View + Menu on a combo capture, and stopping cancels it', async () => {
    const api = createMockApi({ search: '' })
    const events: ComboCaptureEvent[] = []
    api.on('home:capture', (e) => events.push(e))
    await api.startComboCapture()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(events.at(-1)?.done).toEqual(['view', 'menu'])

    events.length = 0
    await api.startComboCapture()
    await api.stopComboCapture()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(events).toEqual([])
  })

  it('keeps a profile as the running game’s own, and clears it with null', async () => {
    const api = createMockApi({ search: '?overlay=1' })
    const { gameId } = await api.getOverlayState()
    const kept = await api.applyPowerProfile('custom', gameId)
    expect(kept.active).toBe('custom')
    expect(kept.gameProfile).toBe('custom')
    expect((await api.getGame(gameId!))?.user.performance).toEqual({ profile: 'custom' })
    // With the helper ready a fallback profile is Dynamic TDP (and kept as Dynamic TDP for the game).
    const fallback = await api.applyPowerProfile('performance', gameId)
    expect(fallback).toMatchObject({ active: 'dynamic', gameProfile: 'dynamic' })
    expect((await api.getGame(gameId!))?.user.performance?.profile).toBe('dynamic')
    const cleared = await api.applyPowerProfile('custom', null)
    expect(cleared.gameProfile).toBeUndefined()
  })

  it('shows a fallback profile saved before the helper as Dynamic TDP with it, and puts it back without', async () => {
    const api = createMockApi({ search: '?overlay=1' })
    const { gameId } = await api.getOverlayState()
    await api.removePowerHelper()
    const kept = await api.applyPowerProfile('balanced', gameId)
    expect(kept).toMatchObject({ active: 'balanced', gameProfile: 'balanced' })
    const installing = api.installPowerHelper()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await installing).toMatchObject({
      active: 'dynamic',
      gameProfile: 'dynamic',
      helper: 'ready'
    })
    expect((await api.getGame(gameId!))?.user.performance?.profile).toBe('balanced')
    expect(await api.removePowerHelper()).toMatchObject({
      active: 'balanced',
      gameProfile: 'balanced'
    })
  })

  it('starts with the power helper ready and Dynamic TDP; removing and installing it again switches back', async () => {
    const api = createMockApi({ search: '' })
    expect(await api.getPerformanceStatus()).toMatchObject({
      active: 'dynamic',
      helper: 'ready',
      watts: { state: 'ready' },
      dynamic: { state: 'idle', targetFps: 60 }
    })
    const removed = await api.removePowerHelper()
    expect(removed).toMatchObject({
      active: null,
      helper: 'missing',
      watts: { state: 'not-installed' }
    })
    expect(removed.dynamic).toBeUndefined()
    const pending = api.installPowerHelper()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await pending).toMatchObject({ active: 'dynamic', watts: { state: 'ready' } })
  })

  it('frees memory from the button: system-wide with the power helper, this user’s apps without', async () => {
    const api = createMockApi({ search: '' })
    expect(await api.getMemoryStatus()).toEqual({
      enabled: false,
      running: false,
      systemWide: 'ready',
      last: null
    })
    const seen: MemoryStatus[] = []
    api.on('memory:status', (s) => seen.push(s))
    const first = api.freeMemoryNow()
    // A second press joins the pass that is running.
    const second = api.freeMemoryNow()
    expect((await api.getMemoryStatus()).running).toBe(true)
    await vi.advanceTimersByTimeAsync(MOCK_MEMORY_PASS_MS)
    const done = await first
    expect(await second).toBe(done)
    expect(done).toMatchObject({
      running: false,
      last: { reason: 'manual', tier: 'system', freedMb: 1843 }
    })
    expect(done.last!.afterAvailableMb - done.last!.beforeAvailableMb).toBe(done.last!.freedMb)
    expect(done.last!.steps.standby?.state).toBe('skipped')
    expect(seen.map((s) => s.running)).toEqual([true, true, false])

    // The setting follows Settings › System, and removing the helper leaves the tier that needs no administrator.
    await api.updateSettings({ performance: { memory: { enabled: true } } })
    expect(seen.at(-1)).toMatchObject({ enabled: true, systemWide: 'ready' })
    await api.removePowerHelper()
    expect(seen.at(-1)).toMatchObject({ systemWide: 'missing' })
    const without = api.freeMemoryNow()
    await vi.advanceTimersByTimeAsync(MOCK_MEMORY_PASS_MS)
    expect((await without).last).toMatchObject({
      tier: 'user',
      freedMb: 640,
      steps: { workingSets: { state: 'done' } }
    })
  })

  it('simulates Dynamic TDP readings during a game and keeps a per-game target', async () => {
    const api = createMockApi({ search: '?overlay=1' })
    const { gameId } = await api.getOverlayState()
    const kept = await api.applyPowerProfile('dynamic', gameId, { targetFps: 45 })
    expect(kept).toMatchObject({ active: 'dynamic', gameProfile: 'dynamic', gameTargetFps: 45 })
    await vi.advanceTimersByTimeAsync(10_000)
    const st = await api.getPerformanceStatus()
    expect(st.dynamic?.targetFps).toBe(45)
    expect(st.dynamic?.fps).toBeGreaterThan(0)
    expect(st.dynamic?.watts).toBeGreaterThanOrEqual(5)
  })

  it('lists the music folder once one is chosen, and changes the display mode', async () => {
    const api = createMockApi({ search: '' })
    expect((await api.getMusicLibrary()).tracks).toEqual([])
    const folder = await api.chooseMusicFolder()
    expect(folder).toBe(MOCK_MUSIC_FOLDER)
    await api.updateSettings({ music: { folder } })
    expect((await api.getMusicLibrary()).tracks.length).toBeGreaterThan(0)

    const display = await api.setDisplayMode({ width: 1280, height: 720, hz: 60 })
    expect(display?.current).toEqual({ width: 1280, height: 720, hz: 60 })
  })

  it('sends settings:changed with the saved settings after every change, like main', async () => {
    const api = createMockApi({ search: '' })
    const seen: number[] = []
    api.on('settings:changed', (settings) => seen.push(settings.music.volume))
    await api.updateSettings({ music: { volume: 0.25 } })
    expect(seen).toEqual([0.25])
  })

  describe('overlay extras', () => {
    it('applies a frame limit to the running game’s exe and remembers it per game', async () => {
      const api = createMockApi({ search: '?overlay=1' })
      const { gameId } = await api.getOverlayState()
      const game = await api.getGame(gameId!)
      const before = await api.getOverlayExtras()
      expect(before.rtss).toEqual({ state: 'running', version: '7.3.7' })
      expect(before.frameLimit).toMatchObject({
        available: true,
        fps: 0,
        exe: mockGameExe(game!.title),
        gameId,
        options: [0, 30, 40, 45, 60, 72, 90, 120]
      })
      const seen: OverlayExtrasStatus[] = []
      api.on('overlay:extras', (s) => seen.push(s))
      const after = await api.setFrameLimit(60)
      expect(after.frameLimit).toMatchObject({ fps: 60, chosen: 60 })
      expect(seen.at(-1)?.frameLimit.fps).toBe(60)
      await expect(api.setFrameLimit(12.5)).rejects.toThrow()

      const live = await api.getLiveStats()
      expect(live.fpsSource).toBe('rtss')
      expect(live.fps).toBeGreaterThanOrEqual(57)
      expect(live.fps).toBeLessThanOrEqual(60)
      expect(live.watts).not.toBeNull()

      expect((await api.setFrameLimit(0)).frameLimit.fps).toBe(0)
    })

    it('refuses a limit without a game, and reads no live stats then', async () => {
      const api = createMockApi({ search: '' })
      const status = await api.getOverlayExtras()
      expect(status.frameLimit).toMatchObject({ available: false, reason: 'Start a game first' })
      await expect(api.setFrameLimit(30)).rejects.toThrow('Start a game first')
      expect(await api.getLiveStats()).toEqual({ fps: null, fpsSource: null, watts: null })
    })

    it('follows the display while synced, and an explicit pick turns sync off', async () => {
      const api = createMockApi({ search: '?overlay=1' })
      await api.setFrameLimit(45)
      const synced = await api.setFrameLimitSync(true)
      expect(synced.sync).toMatchObject({ enabled: true, hz: 120 })
      expect(synced.frameLimit).toMatchObject({ fps: 120, chosen: 45 })
      expect((await api.getSettings()).performance.syncFpsToRefresh).toBe(true)

      const seen: OverlayExtrasStatus[] = []
      api.on('overlay:extras', (s) => seen.push(s))
      await api.setDisplayMode({ width: 1920, height: 1080, hz: 60 })
      expect(seen.at(-1)?.frameLimit.fps).toBe(60)

      const picked = await api.setFrameLimit(30)
      expect(picked.sync.enabled).toBe(false)
      expect(picked.frameLimit.fps).toBe(30)
    })

    it('keeps the performance overlay level in the settings and draws it during a game', async () => {
      const api = createMockApi({ search: '?overlay=1' })
      const status = await api.setPerfOverlayLevel(2)
      expect(status.perfOverlay).toEqual({ level: 2, available: true, drawing: true })
      expect((await api.getSettings()).performance.perfOverlay).toBe(2)
      await expect(api.setPerfOverlayLevel(7 as 0)).rejects.toThrow()
    })

    it('switches Auto HDR', async () => {
      const api = createMockApi({ search: '' })
      expect((await api.getOverlayExtras()).autoHdr).toMatchObject({ enabled: true, hdrOn: true })
      expect((await api.setAutoHdr(false)).autoHdr.enabled).toBe(false)
    })

    it('leaves CPU boost to Dynamic TDP, overrides a preset and edits Custom', async () => {
      const api = createMockApi({ search: '' })
      const dynamic = await api.getOverlayExtras()
      expect(dynamic.cpuBoost).toMatchObject({ available: false, reason: 'Managed by Dynamic TDP' })
      await expect(api.setCpuBoost(false)).rejects.toThrow('Managed by Dynamic TDP')

      // The presets are offered only without the power helper.
      await api.removePowerHelper()
      await api.applyPowerProfile('balanced')
      const off = await api.setCpuBoost(false)
      expect(off.cpuBoost).toMatchObject({ enabled: false, profile: 'balanced', overridden: true })
      expect((await api.getSettings()).performance.boostOverrides).toEqual({ balanced: false })
      const back = await api.setCpuBoost(true)
      expect(back.cpuBoost).toMatchObject({ enabled: true, overridden: false })
      expect((await api.getSettings()).performance.boostOverrides).toEqual({})

      await api.applyPowerProfile('custom')
      const custom = await api.setCpuBoost(true)
      expect(custom.cpuBoost).toMatchObject({ enabled: true, profile: 'custom' })
      expect((await api.getSettings()).performance.profiles.custom.cpuBoost).toBe(true)

      await api.applyPowerProfile('none')
      expect((await api.getOverlayExtras()).cpuBoost).toMatchObject({
        available: false,
        reason: 'Choose a power profile first'
      })
    })
  })

  it('offers Endurance Gaming as the probed Intel driver does, and rejects a choice it does not list', async () => {
    const api = createMockApi({ search: '?overlay=1' })
    const intel = await api.getIntelGraphics()
    expect(intel.enduranceGaming).toMatchObject({ supported: true, value: 'off' })
    expect(intel.enduranceGaming?.options.map((o) => o.key)).not.toContain('on:balanced')
    const next = await api.setEnduranceGaming('auto:battery')
    expect(next.enduranceGaming?.value).toBe('auto:battery')
    await expect(api.setEnduranceGaming('on:balanced')).rejects.toThrow('does not offer')
  })
})
