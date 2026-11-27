import type {
  GameFileNeed,
  GameRecomps,
  InstalledRecomp,
  RecompCloudState,
  RecompEntry,
  RecompExecutable,
  RecompProgress,
  RecompRelease
} from '@shared/recomp'
import type { GameRecompInfo } from '@shared/types'
import { describe, expect, it, vi } from 'vitest'

// state/recomp subscribes to main's events at import time.
vi.mock('../../api/client', () => ({ api: { on: vi.fn(() => () => undefined) } }))

const {
  cloudStatusText,
  conflictText,
  entryActions,
  entryFacts,
  firstReleased,
  lastUpdated,
  needHowText,
  needPickable,
  needsAsStates,
  needSpecText,
  orderedEntries,
  progressText,
  recompButton,
  recompProgressId,
  recompToLaunch,
  exeBadges,
  exeChoiceBadges,
  exeChoiceList,
  exeShownPath,
  exeSourceText,
  releaseInstallLabel,
  shownNeeds,
  shownReleases,
  tagTone,
  verifiedBadge,
  versionBadges
} = await import('./recompView')

const MB = 1024 ** 2

function entry(patch: Partial<RecompEntry> = {}): RecompEntry {
  return {
    id: 'github:zelda64recomp/zelda64recomp',
    name: 'Zelda 64: Recompiled',
    game: "The Legend of Zelda: Majora's Mask",
    systemId: 'n64',
    console: 'Nintendo 64',
    host: 'github',
    repo: 'Zelda64Recomp/Zelda64Recomp',
    repoUrl: 'https://github.com/Zelda64Recomp/Zelda64Recomp',
    author: 'Mr-Wiseguy',
    blurb: "Majora's Mask as a native PC game.",
    description: '',
    features: [],
    tags: [],
    latestTag: 'v1.2.0',
    released: '2025-05-01',
    downloadBytes: 28 * MB,
    stars: 6000,
    downloads: 120000,
    license: 'GPL-3.0',
    completeness: 'playable',
    recommended: true,
    assetPattern: null,
    exe: null,
    installer: false,
    scannedSha256: null,
    needs: [],
    setupNotes: [],
    savePaths: [],
    iconUrl: null,
    coverUrl: null,
    heroUrl: null,
    archived: false,
    sources: ['decomp-buddy'],
    ...patch
  }
}

const CLOUD_OFF: RecompCloudState = {
  enabled: false,
  syncedHash: null,
  localHash: null,
  syncedAt: null,
  pending: false,
  error: null,
  conflict: null
}

function installed(patch: Partial<InstalledRecomp> = {}): InstalledRecomp {
  return {
    id: 'github:zelda64recomp/zelda64recomp',
    dir: 'C:\\PlayOut\\Recompilations\\Zelda64Recompiled',
    tag: 'v1.1.0',
    asset: 'Zelda64Recompiled-Windows.zip',
    downloadBytes: 27 * MB,
    diskBytes: 80 * MB,
    sha256: 'ab',
    verified: 'github',
    exe: 'Zelda64Recompiled.exe',
    installedAt: '2025-04-01T00:00:00Z',
    updatedAt: '2025-04-01T00:00:00Z',
    releaseFiles: [],
    autoUpdate: false,
    gameFiles: {},
    savePaths: [],
    saveSource: null,
    cloud: CLOUD_OFF,
    prevTag: null,
    ...patch
  }
}

function progress(patch: Partial<RecompProgress>): RecompProgress {
  return {
    id: 'x',
    phase: 'downloading',
    progress: null,
    bytes: null,
    total: null,
    message: null,
    warning: null,
    ...patch
  }
}

function need(patch: Partial<GameFileNeed> = {}): GameFileNeed {
  return {
    id: 'game',
    label: 'Game ROM',
    description: "Your Majora's Mask ROM",
    kind: 'game',
    how: 'flag',
    accepts: 'file',
    formats: ['.z64', '.n64'],
    optional: false,
    hashes: [],
    ...patch
  }
}

describe('recompButton', () => {
  const info: GameRecompInfo = {
    titleKey: 'n64:majoras mask',
    count: 2,
    installed: [],
    preferred: 'a',
    updatedAt: '2025-01-01'
  }
  const launch = vi.fn()
  const open = vi.fn()

  it('is absent without recompilations', () => {
    expect(recompButton('MM', undefined, undefined, launch, open)).toBeUndefined()
    expect(recompButton('MM', { ...info, count: 0 }, undefined, launch, open)).toBeUndefined()
  })

  it('opens the page while the chosen one is not installed', () => {
    const b = recompButton('MM', info, undefined, launch, open)
    expect(b).toMatchObject({ state: 'available', label: 'Recompilations' })
    b!.onPress()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('starts the chosen one once installed, by id', () => {
    launch.mockClear()
    const b = recompButton('MM', { ...info, installed: ['b', 'a'] }, undefined, launch, open)
    expect(b).toMatchObject({ state: 'installed', label: 'Play MM (recompilation)' })
    b!.onPress()
    expect(launch).toHaveBeenCalledWith('a')
  })

  it('starts another installed one when the chosen one is not installed', () => {
    launch.mockClear()
    open.mockClear()
    const b = recompButton('MM', { ...info, installed: ['b', 'c'] }, undefined, launch, open, {
      b: 'MM Port'
    })
    expect(b).toMatchObject({ state: 'installed', label: 'Play MM with MM Port' })
    b!.onPress()
    expect(launch).toHaveBeenCalledWith('b')
    expect(open).not.toHaveBeenCalled()
  })

  it('picks the one to start as the delete menu does', () => {
    expect(recompToLaunch(undefined)).toBeUndefined()
    expect(recompToLaunch({ installed: [], preferred: 'a' })).toBeUndefined()
    expect(recompToLaunch({ installed: ['b', 'a'], preferred: 'a' })).toBe('a')
    expect(recompToLaunch({ installed: ['c', 'b'], preferred: 'a' })).toBe('c')
  })

  it('is busy while it installs, and done / failed are not busy', () => {
    expect(recompButton('MM', info, progress({ phase: 'queued' }), launch, open)).toMatchObject({
      state: 'busy',
      label: 'Installing…'
    })
    expect(recompButton('MM', info, progress({ phase: 'failed' }), launch, open)?.state).toBe(
      'available'
    )
    expect(
      recompButton('MM', { ...info, installed: ['a'] }, progress({ phase: 'done' }), launch, open)
        ?.state
    ).toBe('installed')
  })

  it('is busy while the installed one it would start updates (the chosen one not installed)', () => {
    const fallback = { ...info, installed: ['b'] }
    // GameDetail reads the progress of recompProgressId's id: the installed fallback, not the chosen one.
    expect(recompProgressId(fallback)).toBe('b')
    expect(recompProgressId(info)).toBe('a')
    expect(recompProgressId(undefined)).toBeUndefined()
    launch.mockClear()
    open.mockClear()
    const b = recompButton('MM', fallback, progress({ phase: 'downloading' }), launch, open)
    expect(b).toMatchObject({ state: 'busy', label: 'Installing…' })
    b!.onPress()
    expect(open).toHaveBeenCalledTimes(1)
    expect(launch).not.toHaveBeenCalled()
  })

  it('shows the unpack percent, not "Installing", while a game disc is unpacked', () => {
    expect(
      recompButton(
        'MM',
        { ...info, installed: ['a'] },
        progress({ phase: 'extracting', progress: 0.42 }),
        launch,
        open
      )
    ).toMatchObject({ state: 'busy', label: 'Unpacking… 42%' })
  })
})

describe('the program it starts', () => {
  it('says who chose it', () => {
    expect(exeSourceText('user')).toBe('Chosen by you')
    expect(exeSourceText('developer')).toBe('Named by the developer')
    expect(exeSourceText('auto')).toBe("PlayOut's pick")
  })

  it('shows a program in the folder relative and one outside in full', () => {
    expect(
      exeShownPath({
        current: 'bin\\Game.exe',
        currentFull: 'C:\\R\\bin\\Game.exe',
        outside: false
      })
    ).toBe('bin\\Game.exe')
    expect(
      exeShownPath({
        current: 'D:\\Games\\BR\\BR.exe',
        currentFull: 'D:\\Games\\BR\\BR.exe',
        outside: true
      })
    ).toBe('D:\\Games\\BR\\BR.exe')
    expect(exeShownPath({ current: null, currentFull: null, outside: false })).toBe('None found')
  })

  it('marks the program in use, PlayOut’s pick and the ones that are not the game', () => {
    expect(exeBadges({ current: true, auto: true, note: null })).toEqual([
      { label: 'In use', kind: 'accent' },
      { label: "PlayOut's pick", kind: 'plain' }
    ])
    expect(exeBadges({ current: false, auto: false, note: 'Uninstaller' })).toEqual([
      { label: 'Uninstaller', kind: 'warn' }
    ])
  })
})

describe('versions', () => {
  const a = entry({ id: 'a', recommended: true })
  const b = entry({ id: 'b', recommended: false })
  const c = entry({ id: 'c', recommended: false })
  const data: Pick<GameRecomps, 'entries' | 'title' | 'installed' | 'preferred' | 'updates'> = {
    entries: [c, b, a],
    title: {
      key: 'k',
      game: 'MM',
      systemId: 'n64',
      console: 'Nintendo 64',
      entries: ['a', 'b', 'c']
    },
    installed: { b: installed({ id: 'b' }) },
    preferred: 'b',
    updates: { b: 'v2' }
  }

  it('keeps the title order', () => {
    expect(orderedEntries(data).map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('labels the choice, the recommended, the installed and an update', () => {
    expect(versionBadges(a, data).map((x) => x.label)).toEqual(['Recommended'])
    expect(versionBadges(b, data).map((x) => x.label)).toEqual([
      'Your choice',
      'Installed',
      'Update'
    ])
    expect(versionBadges(c, data)).toEqual([])
  })
})

describe('entryActions', () => {
  it('offers Install with the size when not installed', () => {
    expect(entryActions(entry(), undefined, undefined, undefined)).toEqual({
      busy: false,
      install: 'Install · 28 MB',
      play: false,
      update: null,
      pinned: null,
      failed: null,
      warning: null
    })
    expect(
      entryActions(entry({ downloadBytes: null }), undefined, undefined, undefined).install
    ).toBe('Install')
  })

  it('offers Play and the update when installed', () => {
    expect(entryActions(entry(), installed(), 'v1.2.0', undefined)).toMatchObject({
      play: true,
      update: 'v1.2.0',
      install: null
    })
  })

  it('shows the pin instead of an update when kept on an older release', () => {
    const kept = entryActions(
      entry(),
      installed({ tag: 'v1.0.0', pinnedTag: 'v1.0.0' }),
      'v1.2.0',
      undefined
    )
    expect(kept).toMatchObject({ play: true, update: null, pinned: 'v1.0.0' })
    expect(entryActions(entry(), installed(), 'v1.2.0', undefined).pinned).toBeNull()
    // While it installs (Back to latest), the progress shows instead.
    expect(
      entryActions(
        entry(),
        installed({ pinnedTag: 'v1.0.0' }),
        undefined,
        progress({ phase: 'queued' })
      ).pinned
    ).toBeNull()
  })

  it('shows progress instead while busy', () => {
    const busy = entryActions(entry(), installed(), 'v1.2.0', progress({ phase: 'extracting' }))
    expect(busy).toMatchObject({ busy: true, play: false, update: null })
    expect(
      entryActions(entry(), undefined, undefined, progress({ phase: 'queued' })).install
    ).toBeNull()
  })

  it('says why it failed and offers a retry', () => {
    const failed = entryActions(
      entry(),
      undefined,
      undefined,
      progress({ phase: 'failed', message: 'Checksum mismatch' })
    )
    expect(failed).toMatchObject({ failed: 'Checksum mismatch', install: 'Retry install · 28 MB' })
  })

  it('passes the unverified-download warning on', () => {
    const warning = 'This download has no published checksum, so PlayOut could not verify it.'
    expect(
      entryActions(entry(), installed(), undefined, progress({ phase: 'done', warning })).warning
    ).toBe(warning)
  })

  it('drops the warning of a finished install once the version is uninstalled', () => {
    const warning = 'This download has no published checksum, so PlayOut could not verify it.'
    const actions = entryActions(
      entry(),
      undefined,
      undefined,
      progress({ phase: 'done', warning })
    )
    expect(actions).toMatchObject({ warning: null, failed: null, install: 'Install · 28 MB' })
  })
})

describe('releaseInstallLabel', () => {
  type Rel = { tag: string; publishedAt: string | null }
  const rel = (tag: string, publishedAt: string | null = null): Rel => ({ tag, publishedAt })
  const mine = (
    tag: string,
    at = '2026-06-01T00:00:00Z'
  ): Pick<InstalledRecomp, 'tag' | 'installedAt' | 'updatedAt'> => ({
    tag,
    installedAt: at,
    updatedAt: at
  })

  it('offers a plain install when nothing is installed', () => {
    expect(releaseInstallLabel(rel('v2'), [rel('v2')], undefined)).toBe('Install this one')
  })

  it('tells updates from going back by where the installed tag is in the list', () => {
    const list = [rel('v3'), rel('v2'), rel('v1')]
    expect(releaseInstallLabel(rel('v3'), list, mine('v2'))).toBe('Update to this one')
    expect(releaseInstallLabel(rel('v1'), list, mine('v2'))).toBe('Go back to this one')
    // The installed tag is past the 10 rows shown: every shown row is newer.
    const long = Array.from({ length: 12 }, (_, i) => rel(`v${12 - i}`))
    expect(releaseInstallLabel(long[0], long, mine('v1'))).toBe('Update to this one')
  })

  it('does not call an older release an update when the installed tag is gone from the host', () => {
    const list = [rel('v3', '2026-09-01T00:00:00Z'), rel('v1', '2026-01-01T00:00:00Z')]
    expect(releaseInstallLabel(list[0], list, mine('v2'))).toBe('Update to this one')
    expect(releaseInstallLabel(list[1], list, mine('v2'))).toBe('Install this one')
    expect(releaseInstallLabel(rel('v4'), [rel('v4')], mine('v2'))).toBe('Install this one')
  })
})

describe('progressText', () => {
  it('shows the percent and bytes while downloading', () => {
    expect(progressText(progress({ progress: 0.456, bytes: 10 * MB, total: 28 * MB }))).toEqual({
      title: 'Downloading… 46%',
      detail: '10 MB of 28 MB',
      percent: 45.6
    })
  })

  it('names the phase otherwise, with main’s message as the detail', () => {
    expect(progressText(progress({ phase: 'verifying', message: 'sha256' }))).toEqual({
      title: 'Checking the download…',
      detail: 'sha256',
      percent: null
    })
    expect(progressText(progress({ phase: 'downloading' })).percent).toBeNull()
  })

  it('clamps the percent', () => {
    expect(progressText(progress({ progress: 1.7 })).percent).toBe(100)
  })

  it('shows the percent while a setup program’s game is unpacked', () => {
    expect(
      progressText(progress({ phase: 'extracting', progress: 0.42, message: 'Preparing' }))
    ).toEqual({ title: 'Unpacking… 42%', detail: 'Preparing', percent: 42 })
    expect(progressText(progress({ phase: 'extracting' })).title).toBe('Unpacking…')
  })
})

describe('entryFacts', () => {
  it('lists what is known, versions first', () => {
    const facts = entryFacts(entry(), installed(), 'v1.2.0')
    expect(facts.map((f) => f.label)).toEqual([
      'Installed version',
      'Latest version',
      'Released',
      'Last updated',
      'Download size',
      'Size on disk',
      'Completeness',
      'Original',
      'Stars',
      'Downloads',
      'License',
      'By',
      'Download check'
    ])
    expect(facts.find((f) => f.label === 'Size on disk')?.value).toBe('80 MB')
    expect(facts.find((f) => f.label === 'Completeness')?.value).toBe('Playable')
  })

  it('leaves out the unknown and an up-to-date latest version', () => {
    const facts = entryFacts(
      entry({ stars: null, downloads: null, license: null, released: null, completeness: null }),
      installed({ tag: 'v1.2.0', diskBytes: null }),
      undefined
    )
    expect(facts.map((f) => f.label)).toEqual([
      'Installed version',
      'Download size',
      'Original',
      'By',
      'Download check'
    ])
  })

  it('says when the project last put out a release: by its releases when loaded, else by the catalogs', () => {
    const e = entry({ released: '2025-02-01T00:00:00Z', updatedAt: '2025-03-10T00:00:00Z' })
    const at = (facts: { label: string; value: string }[]): string | undefined =>
      facts.find((f) => f.label === 'Last updated')?.value
    expect(lastUpdated(e)).toBe('2025-03-10T00:00:00Z')
    const rel = (tag: string, publishedAt: string | null, prerelease = false): RecompRelease => ({
      tag,
      name: tag,
      publishedAt,
      prerelease,
      notes: '',
      url: '',
      asset: null
    })
    // A newer release than the catalogs know; a test build after it does not count.
    const releases = [
      rel('nightly', '2025-06-01T00:00:00Z', true),
      rel('v1.3.0', '2025-05-20T00:00:00Z'),
      rel('v1.2.0', '2025-03-10T00:00:00Z')
    ]
    expect(lastUpdated(e, releases)).toBe('2025-05-20T00:00:00Z')
    expect(at(entryFacts(e, undefined, undefined, releases))).toBe(
      at(
        entryFacts(
          entry({ released: null, updatedAt: '2025-05-20T00:00:00Z' }),
          undefined,
          undefined
        )
      )
    )
    // With the releases, Released is the project's first one (Last updated its newest).
    const withReleases = entryFacts(e, undefined, undefined, releases)
    expect(withReleases.find((f) => f.label === 'Released')?.value).toBe(
      entryFacts(entry({ released: '2025-03-10T00:00:00Z' }), undefined, undefined).find(
        (f) => f.label === 'Released'
      )?.value
    )
    expect(firstReleased(releases)).toBe('2025-03-10T00:00:00Z')
    expect(firstReleased(null)).toBeNull()
    expect(lastUpdated(entry({ released: null, updatedAt: null }))).toBeNull()
    expect(
      at(entryFacts(entry({ released: null, updatedAt: null }), undefined, undefined))
    ).toBeUndefined()
  })

  it('flags a download without a checksum', () => {
    const facts = entryFacts(entry(), installed({ verified: 'unverified' }), undefined)
    expect(facts.at(-1)).toEqual({
      label: 'Download check',
      value: 'No published checksum',
      tone: 'warn'
    })
  })
})

describe('game files', () => {
  it('turns needs into unset states; self, none and optional are always ready', () => {
    const states = needsAsStates(
      entry({
        needs: [
          need(),
          need({ id: 'bios', how: 'self' }),
          need({ id: 'dlc', optional: true }),
          need({ id: 'x', how: 'none' })
        ]
      })
    )
    expect(states.map((s) => [s.id, s.ready, s.path])).toEqual([
      ['game', false, null],
      ['bios', true, null],
      ['dlc', true, null],
      ['x', true, null]
    ])
    expect(shownNeeds(states).map((s) => s.id)).toEqual(['game', 'bios', 'dlc'])
  })

  it('says how the file gets there', () => {
    expect(needHowText(need({ how: 'self' }), 'Zelda 64')).toMatch(/asks for this itself/)
    expect(needHowText(need({ how: 'folder', folder: 'roms', fileName: 'mm.z64' }), 'Z')).toBe(
      'PlayOut copies it into the install\'s "roms" folder as mm.z64 before each start.'
    )
    expect(needHowText(need({ how: 'folder', folder: '.', fileName: 'Data.rsdk' }), 'Z')).toBe(
      'PlayOut copies it next to the game as Data.rsdk before each start.'
    )
    expect(needHowText(need({ how: 'env', env: 'ROM' }), 'Z')).toBe(
      'PlayOut hands it to Z each time it starts.'
    )
    expect(needPickable(need({ how: 'self' }))).toBe(false)
    expect(needPickable(need({ how: 'folder' }))).toBe(true)
  })

  it('describes a good file', () => {
    expect(needSpecText(need({ region: 'USA', serial: 'NUS-NZSE-USA' }))).toBe(
      'Accepts .z64, .n64 · USA · NUS-NZSE-USA'
    )
    expect(needSpecText(need({ formats: [], accepts: 'folder' }))).toBe('A folder')
  })

  it('badges the verification of a set file only', () => {
    expect(verifiedBadge({ path: null, verified: 'match' })).toBeNull()
    expect(verifiedBadge({ path: 'a', verified: 'match' })).toEqual({
      label: 'Verified',
      tone: 'accent'
    })
    expect(verifiedBadge({ path: 'a', verified: 'mismatch' })?.tone).toBe('warn')
    expect(verifiedBadge({ path: 'a', verified: 'unverified' })?.label).toBe('Not checked')
  })
})

describe('saves and their copy', () => {
  it('reports the state of the copy in the Emulation folder, worst first', () => {
    expect(cloudStatusText(CLOUD_OFF).text).toMatch(/not copied/)
    const on = { ...CLOUD_OFF, enabled: true }
    expect(cloudStatusText(on).text).toBe(
      'Copied to the Emulation folder before and after you play.'
    )
    expect(cloudStatusText({ ...on, pending: true }).text).toMatch(/waiting/)
    expect(cloudStatusText({ ...on, pending: true, error: 'Drive offline' })).toEqual({
      text: 'The saves could not be copied: Drive offline',
      tone: 'warn'
    })
    expect(
      cloudStatusText({
        ...on,
        error: 'x',
        conflict: { localAt: '2025-01-02', cloudAt: '2025-01-03', cloudDevice: 'DECK' }
      }).tone
    ).toBe('warn')
  })

  it('words a conflict', () => {
    const text = conflictText({ localAt: '', cloudAt: '', cloudDevice: 'STEAMDECK' })
    expect(text).toBe(
      "Your saves changed on this PC and in the Emulation folder's copy from STEAMDECK. Pick the ones to keep; the others are kept as a backup."
    )
  })

  it('words saves gone from this PC', () => {
    const gone = { localAt: '', cloudAt: '', cloudDevice: 'STEAMDECK', gone: true }
    expect(conflictText(gone)).toMatch(
      /^This PC has no saves any more, but the Emulation folder has a copy from STEAMDECK\. Restore it, or start fresh/
    )
    expect(cloudStatusText({ ...CLOUD_OFF, enabled: true, conflict: gone })).toEqual({
      text: "This PC's saves are gone: restore them from the Emulation folder or start fresh.",
      tone: 'warn'
    })
  })
})

describe('misc', () => {
  it('tones tags', () => {
    expect(tagTone({ label: 'Playable', kind: 'status' })).toBe('accent')
    expect(tagTone({ label: 'Archived', kind: 'warning' })).toBe('warn')
    expect(tagTone({ label: 'Mods', kind: 'feature' })).toBe('plain')
  })

  it('shows ten releases at most', () => {
    expect(shownReleases(Array.from({ length: 14 }, (_, i) => i))).toHaveLength(10)
    expect(shownReleases([1, 2], 1)).toEqual([1])
  })
})

describe('the UP button’s program chooser', () => {
  const exe = (
    path: string,
    over: { note?: string; auto?: boolean; current?: boolean } = {}
  ): RecompExecutable => ({
    path,
    full: `C:/R/${path}`,
    note: over.note ?? null,
    current: over.current ?? false,
    auto: over.auto ?? false
  })

  it('lists the programs that could be the game first, PlayOut’s pick first, the others after', () => {
    const candidates = [
      exe('Game.exe'),
      exe('Launcher.exe', { auto: true, current: true }),
      exe('unins000.exe', { note: 'Uninstaller' })
    ]
    const { best, list } = exeChoiceList({ candidates })
    expect(best?.path).toBe('Launcher.exe')
    expect(list.map((c) => c.path)).toEqual(['Launcher.exe', 'Game.exe', 'unins000.exe'])
  })

  it('guesses the first that could be the game without a pick, and none when no program could be', () => {
    expect(exeChoiceList({ candidates: [exe('A.exe'), exe('B.exe')] }).best?.path).toBe('A.exe')
    const helpers = exeChoiceList({ candidates: [exe('setup.exe', { note: 'Setup program' })] })
    expect(helpers.best).toBeNull()
    expect(helpers.list.map((c) => c.path)).toEqual(['setup.exe'])
  })

  it('labels the best guess and why a program is probably not the game', () => {
    expect(exeChoiceBadges({ note: null }, true)).toEqual([{ label: 'Best guess', kind: 'accent' }])
    expect(exeChoiceBadges({ note: 'Uninstaller' }, false)).toEqual([
      { label: 'Uninstaller', kind: 'warn' }
    ])
  })
})
