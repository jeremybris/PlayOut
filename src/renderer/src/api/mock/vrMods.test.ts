import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VrModProgress } from '@shared/vr-mods'
import { createMockApi } from './index'
import { EDGE_VR, FF16_VR, PINBALL_QUEST, TOWNFALL_NEXUS, VR_DOWNLOAD_MS } from './vrMods'

function createStorageStub(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key)
    },
    setItem: (key, value) => {
      store.set(key, String(value))
    }
  }
}

describe('mock VR mods', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageStub())
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('lists GitHub, Quest-only and Nexus mods, with Final Fantasy 16 VR downloaded one release behind', async () => {
    const api = createMockApi({ search: '' })
    const view = await api.getVrMods()
    expect(view.root).toMatch(/VR Mods$/)
    expect(view.mods.map((m) => m.id)).toEqual(
      expect.arrayContaining([FF16_VR, EDGE_VR, PINBALL_QUEST, TOWNFALL_NEXUS])
    )
    expect(view.mods.find((m) => m.id === TOWNFALL_NEXUS)?.github).toBeNull()
    expect(view.installed[FF16_VR]?.tag).toBe('v0.8.0')
    expect(view.updates).toEqual({ [FF16_VR]: 'v0.9.0' })
  })

  it('downloads a GitHub mod through the real phases and refuses non-GitHub ones', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const phases: VrModProgress['phase'][] = []
    let changed = 0
    api.on('vr-mods:progress', (p) => {
      if (p.id === EDGE_VR) phases.push(p.phase)
    })
    api.on('vr-mods:changed', () => changed++)
    await api.downloadVrMod(EDGE_VR)
    await vi.advanceTimersByTimeAsync(VR_DOWNLOAD_MS + 100)
    expect(phases[0]).toBe('queued')
    expect(phases).toEqual(
      expect.arrayContaining(['checking', 'downloading', 'verifying', 'extracting', 'installing'])
    )
    expect(phases.at(-1)).toBe('done')
    expect(changed).toBe(1)
    expect((await api.getVrMods()).installed[EDGE_VR]?.verified).toBe('github')
    await expect(api.downloadVrMod(TOWNFALL_NEXUS)).rejects.toThrow(/not on GitHub/)
  })

  it('updates, checks for updates and removes', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    await api.updateVrMod(FF16_VR)
    await vi.advanceTimersByTimeAsync(VR_DOWNLOAD_MS + 100)
    expect((await api.getVrMods()).installed[FF16_VR]?.tag).toBe('v0.9.0')
    const check = api.checkVrModUpdates()
    await vi.advanceTimersByTimeAsync(500)
    expect(await check).toEqual({})
    const phases: VrModProgress['phase'][] = []
    api.on('vr-mods:progress', (p) => {
      if (p.id === FF16_VR) phases.push(p.phase)
    })
    const removing = api.removeVrMod(FF16_VR)
    // Busy while its folder is deleted: no download of it starts meanwhile.
    await expect(api.updateVrMod(FF16_VR)).rejects.toThrow(/being removed/)
    await expect(api.downloadVrMod(FF16_VR)).rejects.toThrow(/being removed/)
    await vi.advanceTimersByTimeAsync(500)
    await removing
    expect(phases).toEqual(['removing', 'done'])
    expect((await api.getVrMods()).installed).toEqual({})
  })

  it('fails a Quest-only mod with no download', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    let last: VrModProgress | null = null
    api.on('vr-mods:progress', (p) => {
      if (p.id === PINBALL_QUEST) last = p
    })
    await api.downloadVrMod(PINBALL_QUEST)
    await vi.advanceTimersByTimeAsync(VR_DOWNLOAD_MS)
    expect(last).toMatchObject({ phase: 'failed' })
  })
})
