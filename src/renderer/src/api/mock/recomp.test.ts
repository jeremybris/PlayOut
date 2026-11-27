import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlayOutApi } from '@shared/api'
import type { RecompProgress } from '@shared/recomp'
import { createMockApi } from './index'
import {
  DOOM64EX,
  DOOM64EX_PLUS,
  MOCK_CRASH_AFTER_MS,
  MOCK_IMAGE_TEST_MS,
  RECOMP_INSTALL_MS,
  SONIC2_DECOMP,
  XERENGE,
  XERENGE_UNPACKED
} from './recomp'

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

async function gameIdOf(api: PlayOutApi, title: string): Promise<string> {
  const { games } = await api.getLibrary()
  const game = games.find((g) => g.source === 'rom' && g.title === title)
  if (!game) throw new Error(`no ${title} in the mock library`)
  return game.id
}

describe('mock recompilations', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageStub())
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('adds a GitHub repository in the browser: checked, shown as added by you, then removed', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const check = (url: string): ReturnType<PlayOutApi['checkRecompRepo']> => {
      const p = api.checkRecompRepo(url)
      void vi.advanceTimersByTimeAsync(1000)
      return p
    }
    expect(await check('https://gitlab.com/a/b')).toMatchObject({ ok: false, reason: 'notGithub' })
    expect(await check('github.com/a/missing')).toMatchObject({ ok: false, reason: 'notFound' })
    expect(await check('github.com/a/nowin')).toMatchObject({ ok: false, reason: 'noWindows' })
    const ok = await check(await api.readRecompClipboard())
    expect(ok).toMatchObject({ ok: true, repo: 'Zelda64Recomp/Zelda64Recomp' })
    if (!ok.ok) throw new Error('not ok')
    const adding = api.addRecomp({ id: ok.id, game: 'Doom 64', systemId: 'n64' })
    await vi.advanceTimersByTimeAsync(500)
    const added = await adding
    expect(added.titleKey).toBe('n64:doom 64')
    const listed = await check('Zelda64Recomp/Zelda64Recomp')
    expect(listed).toMatchObject({ ok: false, reason: 'alreadyListed', existingId: ok.id })
    const find = async (): Promise<unknown> =>
      (await api.browseRecomps()).titles.flatMap((t) => t.entries).find((e) => e.id === ok.id)
    expect(await find()).toMatchObject({ added: 'queued', awaiting: true, isNew: false })
    await vi.advanceTimersByTimeAsync(2500)
    expect(await find()).toMatchObject({ added: 'suggested', awaiting: true })
    const removing = api.removeAddedRecomp(ok.id, false)
    await vi.advanceTimersByTimeAsync(500)
    await removing
    expect(await find()).toBeUndefined()
  })

  it('marks the matched sample games with metadata.recomp', async () => {
    const api = createMockApi({ search: '' })
    const { games } = await api.getLibrary()
    const doom = games.find((g) => g.title === 'Doom 64')!
    const sonic = games.find((g) => g.title === 'Sonic the Hedgehog 2')!
    expect(doom.metadata.recomp).toMatchObject({
      titleKey: 'n64:doom 64',
      count: 2,
      installed: [DOOM64EX_PLUS],
      preferred: DOOM64EX_PLUS
    })
    expect(sonic.metadata.recomp).toMatchObject({
      count: 1,
      installed: [],
      preferred: SONIC2_DECOMP
    })
    expect(games.filter((g) => g.metadata.recomp)).toHaveLength(3)
    expect(await api.getGameRecomps(games.find((g) => g.title === 'Hades')!.id)).toBeNull()
  })

  it("shows Burnout Revenge's recompilation achievements, gamerscore and unlock dates", async () => {
    const api = createMockApi({ search: '' })
    const id = await gameIdOf(api, 'Burnout Revenge')
    const before = (await api.getLibrary()).games.find((g) => g.id === id)!
    expect(before.metadata.recomp?.achievements).toEqual([XERENGE])
    const info = await api.getAchievements(id)
    expect(info).toMatchObject({ provider: 'recomp', total: 8, unlocked: 3 })
    expect(info?.points?.total).toBeGreaterThan(info!.points!.earned)
    expect(info?.list.filter((a) => a.unlocked).every((a) => a.unlockedAt)).toBe(true)
    // The counts land on the card, as main's do.
    const after = (await api.getLibrary()).games.find((g) => g.id === id)!
    expect(after.metadata.achievements).toMatchObject({ unlocked: 3, total: 8 })
  })

  it('getGameRecomps lists both Doom 64 ports with the installed one, its update and the ROM found', async () => {
    const api = createMockApi({ search: '' })
    const id = await gameIdOf(api, 'Doom 64')
    const view = (await api.getGameRecomps(id))!
    expect(view.entries.map((e) => e.id)).toEqual([DOOM64EX_PLUS, DOOM64EX])
    expect(Object.keys(view.installed)).toEqual([DOOM64EX_PLUS])
    // The beta is newer but a prerelease: the stable v4.0.0.4 is the update.
    expect(view.updates).toEqual({ [DOOM64EX_PLUS]: 'v4.0.0.4' })
    expect(view.libraryFiles[0]).toMatch(/Doom 64 \(USA\)\.z64$/)
    expect(view.gameFiles[DOOM64EX]![0]).toMatchObject({
      source: 'library',
      ready: true,
      verified: 'match'
    })
  })

  it('installs with progress events, then updates the metadata and emits recomp:changed', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const id = await gameIdOf(api, 'Doom 64')
    const phases: RecompProgress[] = []
    const changed = vi.fn()
    api.on('recomp:progress', (p) => phases.push(p))
    api.on('recomp:changed', changed)

    await api.installRecomp(DOOM64EX)
    await expect(api.installRecomp(DOOM64EX)).rejects.toThrow(/already installing/)
    await vi.advanceTimersByTimeAsync(RECOMP_INSTALL_MS + 100)

    expect(phases[0]!.phase).toBe('queued')
    expect(phases.some((p) => p.phase === 'downloading' && p.progress === 0.5)).toBe(true)
    const last = phases.at(-1)!
    expect(last.phase).toBe('done')
    // Doom64EX's releases publish no checksum: the install carries the warning.
    expect(last.warning).toMatch(/could not verify/)
    expect(changed).toHaveBeenCalledWith({ ids: [DOOM64EX] })

    const { games } = await api.getLibrary()
    expect(games.find((g) => g.id === id)!.metadata.recomp!.installed).toEqual([
      DOOM64EX_PLUS,
      DOOM64EX
    ])
    const view = await api.getRecompSettings()
    expect(view.rows.map((r) => r.entry.id).sort()).toEqual(
      [DOOM64EX, DOOM64EX_PLUS, XERENGE].sort()
    )
    expect(view.rows.find((r) => r.entry.id === DOOM64EX)!.installed.verified).toBe('unverified')
    expect(view.busy).toEqual([])
  })

  it('updates all, one after another, and nothing is left to update', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    expect(
      await Promise.all([api.checkRecompUpdates(), vi.advanceTimersByTimeAsync(400)]).then(
        ([u]) => u
      )
    ).toEqual({ [DOOM64EX_PLUS]: 'v4.0.0.4' })
    await api.updateAllRecomps()
    expect((await api.getRecompSettings()).busy.map((p) => p.id)).toEqual([DOOM64EX_PLUS])
    await vi.advanceTimersByTimeAsync(RECOMP_INSTALL_MS + 100)
    const row = (await api.getRecompSettings()).rows[0]!
    expect(row.installed.tag).toBe('v4.0.0.4')
    expect(row.installed.prevTag).toBe('v4.0.0.3')
    expect(row.update).toBeNull()
    // The user's choices survive the update.
    expect(row.installed.cloud.enabled).toBe(true)
    expect(row.installed.gameFiles.game?.source).toBe('library')
  })

  it('swaps the preferred version and refuses one of another game', async () => {
    const api = createMockApi({ search: '' })
    const id = await gameIdOf(api, 'Doom 64')
    await api.setPreferredRecomp(id, DOOM64EX)
    expect((await api.getGameRecomps(id))!.preferred).toBe(DOOM64EX)
    const { games } = await api.getLibrary()
    expect(games.find((g) => g.id === id)!.metadata.recomp!.preferred).toBe(DOOM64EX)
    await expect(api.setPreferredRecomp(id, SONIC2_DECOMP)).rejects.toThrow()
    // Not installed: pressing UP says so.
    expect(await api.launchRecomp(id)).toMatchObject({ ok: false, reason: 'not-installed' })
  })

  it('launches the installed port as a play session of the game', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const id = await gameIdOf(api, 'Doom 64')
    const started = vi.fn()
    api.on('session:started', started)
    // Doom64EX+ has two programs that could be the game: UP asks which (PlayOut's pick among them), starts nothing.
    const asked = await api.launchRecomp(id)
    expect(asked).toMatchObject({ ok: false, reason: 'choose-exe', recompId: DOOM64EX_PLUS })
    if (!asked.ok && asked.reason === 'choose-exe')
      expect(asked.executables.candidates.find((c) => c.auto)?.path).toBe('DOOM64EX-Plus.exe')
    expect(started).not.toHaveBeenCalled()
    // The pick is saved; UP starts it, and later starts do not ask.
    await api.setRecompExecutable(DOOM64EX_PLUS, 'DOOM64EX-Plus.exe')
    expect(await api.launchRecomp(id)).toEqual({ ok: true })
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ gameId: id }))
    expect(await api.getRunningGame()).toMatchObject({ gameId: id })
  })

  it('lists Doom64EX+’s programs and starts the one chosen, or PlayOut’s pick again', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const list = await api.listRecompExecutables(DOOM64EX_PLUS)
    expect(list).toMatchObject({ current: 'DOOM64EX-Plus.exe', source: 'auto' })
    expect(list.candidates.map((c) => [c.path, c.note])).toEqual([
      ['DOOM64EX-Plus.exe', null],
      ['DOOM64EX-Plus-Vulkan.exe', null],
      ['tools\\wadgen.exe', 'Helper program'],
      ['unins000.exe', 'Uninstaller'],
      ['crashpad_handler.exe', 'Crash reporter']
    ])
    expect(await api.setRecompExecutable(DOOM64EX_PLUS, 'tools\\wadgen.exe')).toMatchObject({
      current: 'tools\\wadgen.exe',
      source: 'user'
    })
    await expect(api.setRecompExecutable(DOOM64EX_PLUS, 'readme.txt')).rejects.toThrow(
      'not a program'
    )
    const picking = api.pickRecompExecutable(DOOM64EX_PLUS)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await picking).toMatchObject({ outside: true, source: 'user' })
    expect(await api.setRecompExecutable(DOOM64EX_PLUS, null)).toMatchObject({
      current: 'DOOM64EX-Plus.exe',
      source: 'auto'
    })
    // Automatic is the player accepting PlayOut's pick: UP starts it without asking.
    expect(await api.launchRecomp(await gameIdOf(api, 'Doom 64'))).toEqual({ ok: true })
  })

  it('asks for Sonic 2 data first, then accepts a picked file', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const id = await gameIdOf(api, 'Sonic the Hedgehog 2')
    // Before the pick the .md ROM does not satisfy a .rsdk need.
    const view = (await api.getGameRecomps(id))!
    expect(view.gameFiles[SONIC2_DECOMP]![0]).toMatchObject({ path: null, ready: false })

    void api.installRecomp(SONIC2_DECOMP)
    await vi.advanceTimersByTimeAsync(RECOMP_INSTALL_MS + 100)
    const result = await api.launchRecomp(id)
    expect(result).toMatchObject({ ok: false, reason: 'needs-files' })

    const picked = api.pickRecompGameFile(id, SONIC2_DECOMP, 'game')
    await vi.advanceTimersByTimeAsync(400)
    expect((await picked)[0]).toMatchObject({ source: 'picked', ready: true, verified: 'match' })
    expect(await api.launchRecomp(id)).toEqual({ ok: true })

    const cleared = await api.setRecompGameFile(id, SONIC2_DECOMP, 'game', null)
    expect(cleared[0]!.ready).toBe(false)
  })

  it('asks to delete the original once the program is identified, and the kept card starts the recompilation', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const offers = vi.fn()
    api.on('recomp:image-offers', offers)
    // Doom64EX+ is started with the ROM (a flag): never asked.
    await api.setRecompExecutable(DOOM64EX_PLUS, 'DOOM64EX-Plus.exe')
    expect(offers).not.toHaveBeenCalled()
    expect(await api.getRecompImageOffers()).toEqual([])

    const id = await gameIdOf(api, 'Sonic the Hedgehog 2')
    void api.installRecomp(SONIC2_DECOMP)
    await vi.advanceTimersByTimeAsync(RECOMP_INSTALL_MS + 100)
    const picked = api.pickRecompGameFile(id, SONIC2_DECOMP, 'game')
    await vi.advanceTimersByTimeAsync(400)
    await picked
    expect((await api.getGameRecomps(id))!.originalImage).toMatchObject({
      recompId: SONIC2_DECOMP,
      kept: false
    })
    // Automatic: the player confirmed PlayOut's pick, so it asks at once.
    await api.setRecompExecutable(SONIC2_DECOMP, null)
    const [offer] = await api.getRecompImageOffers()
    expect(offer).toMatchObject({ recompId: SONIC2_DECOMP, gameId: id })
    expect(offers).toHaveBeenLastCalledWith({ offers: [offer] })

    const answer = api.answerRecompImageOffer(offer!.key, 'delete')
    await vi.advanceTimersByTimeAsync(400)
    expect(await answer).toMatchObject({ ok: true })
    const game = (await api.getLibrary()).games.find((g) => g.id === id)!
    expect(game.romPath).toBeUndefined()
    expect(game.romRemoved).toMatchObject({ recompId: SONIC2_DECOMP })
    expect(await api.getRecompImageOffers()).toEqual([])
    expect((await api.getGameRecomps(id))!.originalImage).toBeNull()
    expect(await api.getLocalDeletePlan(id)).toMatchObject({ kind: 'remove-only' })
    // The check after Delete: Sonic 2's decompilation "crashes" right after it starts, so Restore is asked.
    await vi.advanceTimersByTimeAsync(MOCK_CRASH_AFTER_MS + 400)
    const [item] = await api.getRecompHeldImages()
    expect(item).toMatchObject({ recompId: SONIC2_DECOMP, gameId: id, state: 'crashed' })
    expect(item!.reason).toContain('closed')
    const anyway = api.answerRecompHeldImage(item!.holdId, 'delete')
    await vi.advanceTimersByTimeAsync(400)
    expect(await anyway).toMatchObject({ ok: true })
    expect(await api.getRecompHeldImages()).toEqual([])
    // Play starts the recompilation.
    expect(await api.launchGame(id)).toMatchObject({ ok: true })
  })

  it('the check after Delete: a crash asks to Restore, which makes the card a ROM again', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const id = await gameIdOf(api, 'Sonic the Hedgehog 2')
    const before = (await api.getLibrary()).games.find((g) => g.id === id)!
    void api.installRecomp(SONIC2_DECOMP)
    await vi.advanceTimersByTimeAsync(RECOMP_INSTALL_MS + 100)
    const picked = api.pickRecompGameFile(id, SONIC2_DECOMP, 'game')
    await vi.advanceTimersByTimeAsync(400)
    await picked
    await api.setRecompExecutable(SONIC2_DECOMP, null)
    const [offer] = await api.getRecompImageOffers()
    const held = vi.fn()
    api.on('recomp:held-images', held)
    const answer = api.answerRecompImageOffer(offer!.key, 'delete')
    await vi.advanceTimersByTimeAsync(400)
    expect((await answer).message).toContain('aside')
    expect((await api.getRecompHeldImages())[0]).toMatchObject({ state: 'testing' })
    await vi.advanceTimersByTimeAsync(MOCK_CRASH_AFTER_MS + 400)
    const [item] = await api.getRecompHeldImages()
    expect(item).toMatchObject({ state: 'crashed' })
    const restore = api.answerRecompHeldImage(item!.holdId, 'restore')
    await vi.advanceTimersByTimeAsync(400)
    expect(await restore).toMatchObject({ ok: true })
    const game = (await api.getLibrary()).games.find((g) => g.id === id)!
    expect(game.romRemoved).toBeUndefined()
    expect(game.romPath).toBe(before.romPath)
    expect(game.launch).toEqual(before.launch)
    // Kept for that recompilation: not offered again.
    expect(await api.getRecompImageOffers()).toEqual([])
    expect((await api.getGameRecomps(id))!.originalImage).toMatchObject({ kept: true })
    expect(await api.getRecompHeldImages()).toEqual([])
  })

  it('recomp=conflict: launching reports the conflict until a side is kept', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '?recomp=conflict' })
    const id = await gameIdOf(api, 'Doom 64')
    // Which program starts it is asked first (before the saves are looked at).
    expect(await api.launchRecomp(id)).toMatchObject({ ok: false, reason: 'choose-exe' })
    await api.setRecompExecutable(DOOM64EX_PLUS, 'DOOM64EX-Plus.exe')
    expect(await api.launchRecomp(id)).toMatchObject({ ok: false, reason: 'save-conflict' })
    const state = await api.resolveRecompConflict(DOOM64EX_PLUS, 'cloud')
    expect(state.conflict).toBeNull()
    expect(await api.launchRecomp(id)).toEqual({ ok: true })
  })

  it('save folders: add, reset to the catalog, copies in the Emulation folder, off and on', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const added = api.addRecompSaveFolder(DOOM64EX_PLUS)
    await vi.advanceTimersByTimeAsync(400)
    expect(await added).toHaveLength(2)
    let row = (await api.getRecompSettings()).rows[0]!
    expect(row.installed.saveSource).toBe('user')
    expect(row.resolvedSavePaths[0]).toBe('C:\\Users\\Player\\AppData\\Roaming\\doom64ex-plus')

    expect(await api.setRecompSavePaths(DOOM64EX_PLUS, null)).toEqual(['%APPDATA%\\doom64ex-plus'])
    row = (await api.getRecompSettings()).rows[0]!
    expect(row.installed.saveSource).toBe('catalog')

    const view = await api.getRecompSettings()
    expect(view.savesDir).toMatch(/\\Emulation\\Recompilations Saves$/)
    expect(view.rows[0]!.savesDir.startsWith(view.savesDir + '\\')).toBe(true)
    await api.setRecompCloud(DOOM64EX_PLUS, false)
    expect((await api.getRecompSettings()).rows[0]!.installed.cloud.enabled).toBe(false)
    await api.setRecompCloud(DOOM64EX_PLUS, true)
    const sync = api.syncRecompSaves(DOOM64EX_PLUS)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await sync).toMatchObject({ pending: false, error: null })
    await api.setRecompAutoUpdate(DOOM64EX_PLUS, true)
    expect((await api.getRecompSettings()).rows[0]!.installed.autoUpdate).toBe(true)
  })

  it('changes version: an older release is pinned (no update), Back to latest unpins, as main', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const [releases] = await Promise.all([
      api.getRecompReleases(DOOM64EX_PLUS),
      vi.advanceTimersByTimeAsync(1000)
    ])
    // A pre-release and a release without a Windows download, for the Change version list.
    expect(releases.some((r) => r.prerelease)).toBe(true)
    expect(releases.find((r) => r.asset === null)?.tag).toBe('v4.0.0.3a')
    // Marked as main marks them: the newest, and which choices pin.
    expect(releases.filter((r) => r.newest).map((r) => r.tag)).toEqual(['v4.0.0.4'])
    expect(releases.find((r) => r.tag === 'v4.0.0.2')?.pins).toBe(true)
    expect(releases.find((r) => r.tag === 'v4.0.0.4')?.pins).toBe(false)
    expect(releases.find((r) => r.prerelease)?.pins).toBe(false)
    expect(releases.find((r) => r.asset === null)?.pins).toBe(false)
    let row = (await api.getRecompSettings()).rows[0]!
    expect(row.release).toEqual({ prerelease: false, latest: 'v4.0.0.4' })
    await expect(api.setRecompVersion(DOOM64EX_PLUS, 'v9')).rejects.toThrow(/not a release/)
    await expect(api.setRecompVersion(DOOM64EX_PLUS, 'v4.0.0.3a')).rejects.toThrow(
      /no Windows download/
    )

    await api.setRecompVersion(DOOM64EX_PLUS, 'v4.0.0.2')
    await vi.advanceTimersByTimeAsync(RECOMP_INSTALL_MS + 100)
    row = (await api.getRecompSettings()).rows[0]!
    expect(row.installed).toMatchObject({
      tag: 'v4.0.0.2',
      pinnedTag: 'v4.0.0.2',
      prevTag: 'v4.0.0.3'
    })
    expect(row.update).toBeNull()
    const [updates] = await Promise.all([
      api.checkRecompUpdates(),
      vi.advanceTimersByTimeAsync(400)
    ])
    expect(updates).toEqual({})
    await api.updateAllRecomps()
    expect((await api.getRecompSettings()).busy).toEqual([])

    await api.setRecompVersion(DOOM64EX_PLUS, null)
    await vi.advanceTimersByTimeAsync(RECOMP_INSTALL_MS + 100)
    row = (await api.getRecompSettings()).rows[0]!
    expect(row.installed).toMatchObject({ tag: 'v4.0.0.4', pinnedTag: null })

    // An older release from the Recompilation page's Releases list pins it as well (main's runInstall).
    await api.installRecomp(DOOM64EX_PLUS, 'v4.0.0.2')
    await vi.advanceTimersByTimeAsync(RECOMP_INSTALL_MS + 100)
    row = (await api.getRecompSettings()).rows[0]!
    expect(row.installed).toMatchObject({ tag: 'v4.0.0.2', pinnedTag: 'v4.0.0.2' })
    expect(row.update).toBeNull()
  })

  it('recomp=pinned: the game page sees Doom64EX+ pinned, with no update offered', async () => {
    const api = createMockApi({ search: '?recomp=pinned' })
    const view = (await api.getGameRecomps(await gameIdOf(api, 'Doom 64')))!
    expect(view.installed[DOOM64EX_PLUS]).toMatchObject({ tag: 'v4.0.0.3', pinnedTag: 'v4.0.0.3' })
    expect(view.updates).toEqual({})
    expect((await api.getRecompSettings()).rows[0]!.update).toBeNull()
  })

  it('uninstalls, releases and readme, catalog refresh', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const releases = api.getRecompReleases(DOOM64EX_PLUS)
    const readme = api.getRecompReadme(DOOM64EX_PLUS)
    const refresh = api.refreshRecompCatalog()
    await vi.advanceTimersByTimeAsync(1000)
    expect((await releases)[0]).toMatchObject({ prerelease: true })
    expect(await readme).toContain('# Doom64EX+')
    expect(await refresh).toMatchObject({ matchedGames: 3, refreshing: false })

    await api.uninstallRecomp(DOOM64EX_PLUS)
    expect((await api.getRecompSettings()).rows.map((r) => r.entry.id)).toEqual([XERENGE])
    const id = await gameIdOf(api, 'Doom 64')
    const { games } = await api.getLibrary()
    expect(games.find((g) => g.id === id)!.metadata.recomp!.installed).toEqual([])
  })

  it('suggests save folders and adds one, and finds them automatically', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    let saves = await api.getRecompSaves(DOOM64EX_PLUS)
    expect(saves.suggestions).toEqual(['C:\\Users\\Player\\Documents\\My Games\\DOOM 64'])
    await api.addRecompSaveFolder(DOOM64EX_PLUS, saves.suggestions[0])
    saves = await api.getRecompSaves(DOOM64EX_PLUS)
    expect(saves.suggestions).toEqual([])
    expect(saves.resolved).toContain('C:\\Users\\Player\\Documents\\My Games\\DOOM 64')
    await expect(api.addRecompSaveFolder(DOOM64EX_PLUS, 'C:\\Users\\Player')).rejects.toThrow(
      /too broad/
    )
    const found = api.findRecompSaveFolders(DOOM64EX_PLUS)
    await vi.advanceTimersByTimeAsync(1000)
    expect((await found).suggestions).toHaveLength(1)
  })
})

describe('mock recompilations: the unpacked game folder', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageStub())
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("offers Burnout Revenge's disc image and Xerenge's unpacked folder in the Delete dropdown", async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const id = await gameIdOf(api, 'Burnout Revenge')
    expect((await api.getGameRecomps(id))!.originalImage).toEqual({
      recompId: XERENGE,
      fileName: 'Burnout Revenge (USA).iso',
      kept: false,
      folder: { path: XERENGE_UNPACKED, totalBytes: expect.any(Number), kept: false }
    })
    const offer = await api.askRecompImageDelete(id, XERENGE)
    expect(offer).toMatchObject({
      fileName: 'Burnout Revenge (USA).iso',
      folder: { path: XERENGE_UNPACKED }
    })
    // Delete the unpacked game folder: the image stays (remembered as kept), the folder is moved aside, Xerenge is
    // started to check it runs without it, and it passes: the folder goes to the Recycle Bin.
    const notes = vi.fn()
    api.on('recomp:held-images', notes)
    const answer = api.answerRecompImageOffer(offer.key, 'delete-folder')
    await vi.advanceTimersByTimeAsync(400)
    expect(await answer).toEqual({
      ok: true,
      message: `Moved ${XERENGE_UNPACKED} aside. Starting Xerenge to check it runs without it; it goes to the Recycle Bin once you close the game and it ran fine.`
    })
    await vi.advanceTimersByTimeAsync(MOCK_IMAGE_TEST_MS + 400)
    // Still running proves nothing: the verdict waits for the game to close (the mock's session ends on its own).
    expect(await api.getRecompHeldImages()).toMatchObject([{ state: 'testing' }])
    await vi.advanceTimersByTimeAsync(6_000)
    expect(await api.getRecompHeldImages()).toEqual([])
    expect(notes).toHaveBeenLastCalledWith({
      items: [],
      note: {
        ok: true,
        message: `Xerenge started without ${XERENGE_UNPACKED}; it is now in the Recycle Bin.`
      }
    })
    expect((await api.getGameRecomps(id))!.originalImage).toEqual({
      recompId: XERENGE,
      fileName: 'Burnout Revenge (USA).iso',
      kept: true,
      folder: null
    })
    expect((await api.getLibrary()).games.find((g) => g.id === id)!.romPath).toBeTruthy()
  })

  it("shows the same Delete in Settings › Recompilations, on Xerenge's row only", async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const id = await gameIdOf(api, 'Burnout Revenge')
    const rows = (await api.getRecompSettings()).rows
    const row = rows.find((r) => r.entry.id === XERENGE)
    expect(row?.originalImage).toEqual({
      ...(await api.getGameRecomps(id))!.originalImage,
      gameId: id
    })
    expect(row?.originalImage?.folder?.path).toBe(XERENGE_UNPACKED)
    // A recompilation whose game has nothing to let go shows nothing.
    expect(rows.filter((r) => r.entry.id !== XERENGE && r.originalImage)).toEqual([])
    const offer = await api.askRecompImageDelete(id, XERENGE)
    const both = api.answerRecompImageOffer(offer.key, 'delete-both')
    await vi.advanceTimersByTimeAsync(400)
    expect(await both).toMatchObject({ ok: true })
    expect(
      (await api.getRecompSettings()).rows.find((r) => r.entry.id === XERENGE)?.originalImage
    ).toBeNull()
  })

  it('Delete both moves the image and the folder; a folder-only question follows a deleted image', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const id = await gameIdOf(api, 'Burnout Revenge')
    const first = await api.askRecompImageDelete(id, XERENGE)
    const image = api.answerRecompImageOffer(first.key, 'delete')
    await vi.advanceTimersByTimeAsync(400)
    expect(await image).toMatchObject({ ok: true })
    // The folder is still offered (kept), alone.
    const again = await api.askRecompImageDelete(id, XERENGE)
    expect(again).toMatchObject({ fileName: null, folder: { path: XERENGE_UNPACKED, kept: true } })
    expect(await api.answerRecompImageOffer(again.key, 'delete-both')).toMatchObject({
      ok: false,
      message: /offers no disc image/
    })
    const folder = api.answerRecompImageOffer(again.key, 'delete-folder')
    await vi.advanceTimersByTimeAsync(400)
    expect(await folder).toMatchObject({ ok: true })
    expect((await api.getGameRecomps(id))!.originalImage).toBeNull()
  })

  it('never offers the folder once the game is installed around it', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ search: '' })
    const id = await gameIdOf(api, 'Burnout Revenge')
    await api.setRecompExecutable(
      XERENGE,
      `${XERENGE_UNPACKED.replace(/\\game$/, '')}\\bin\\burnout.exe`
    )
    expect((await api.getGameRecomps(id))!.originalImage?.folder).toBeNull()
    const [offer] = await api.getRecompImageOffers()
    expect(offer).toMatchObject({ fileName: 'Burnout Revenge (USA).iso', folder: null })
  })
})
