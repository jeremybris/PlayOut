// The browser's Add in the recompilation service: checking and adding a GitHub repository, how an add shows (and is
// sent through a fake metadata cloud), PlayOut's own list, Remove (with or without uninstalling), and that the adds
// never count as loaded catalogs. Temp folders and fakes only.
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AddedRecompState,
  CloudRecomp,
  InstalledRecomp,
  RecompEntry,
  RecompSendResult,
  RecompTitle
} from '../../shared/recomp'
import type { Game, GameMetadata } from '../../shared/types'
import type { Logger } from '../logger'
import { readAdded } from './added'
import type { RecompCatalog } from './catalog'
import type { GhRelease } from './releases'
import {
  createRecompService,
  stubEntry,
  type RecompCloudLink,
  type RecompLibrary,
  type RecompService,
  type RecompServiceDeps
} from './service'
import { createRecompState, defaultCloudState } from './state'
import { titleKeyOf } from './titles'

const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const GAME = "The Legend of Zelda: Majora's Mask"
const KEY = titleKeyOf('n64', GAME)
const ZELDA = 'github:zelda64/zelda64recomp'
const MINE = 'github:someone/mmport'

function catalog(empty = false): RecompCatalog {
  if (empty)
    return {
      entries: new Map(),
      titles: new Map(),
      byRepo: new Map(),
      fetchedAt: { 'decomp-buddy': null, recomplauncher: null },
      offline: ['decomp-buddy', 'recomplauncher']
    }
  const zelda: RecompEntry = {
    ...stubEntry(ZELDA, null),
    name: 'Zelda 64: Recompiled',
    game: GAME,
    systemId: 'n64',
    console: 'Nintendo 64',
    sources: ['decomp-buddy']
  }
  const title: RecompTitle = {
    key: KEY,
    game: GAME,
    systemId: 'n64',
    console: 'Nintendo 64',
    entries: [ZELDA]
  }
  return {
    entries: new Map([[ZELDA, zelda]]),
    titles: new Map([[KEY, title]]),
    byRepo: new Map([[ZELDA, [ZELDA]]]),
    fetchedAt: { 'decomp-buddy': '2026-11-01T00:00:00.000Z', recomplauncher: null },
    offline: []
  }
}

function library(games: Game[] = []): RecompLibrary {
  const byId = new Map(games.map((g) => [g.id, g]))
  return {
    games: () => [...byId.values()],
    getGame: (id: string) => byId.get(id),
    applyMetadata: ((id: string, update: { metadata?: Partial<GameMetadata> }) => {
      const g = byId.get(id)!
      g.metadata = { ...g.metadata, ...update.metadata }
      return g
    }) as RecompLibrary['applyMetadata'],
    clearMetadataField: (() => false) as RecompLibrary['clearMetadataField']
  }
}

/** GitHub's GET /repos for someone/MMPort (public). */
const github = (async (url: string | URL | Request) => {
  if (String(url).toLowerCase() !== 'https://api.github.com/repos/someone/mmport')
    return new Response('{}', { status: 404 })
  return new Response(
    JSON.stringify({
      full_name: 'someone/MMPort',
      private: false,
      visibility: 'public',
      description: 'Majora’s Mask on PC.',
      stargazers_count: 7,
      license: { spdx_id: 'MIT' },
      archived: false,
      fork: true
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}) as typeof fetch

const releases: GhRelease[] = [
  {
    tag_name: 'v0.3.0',
    name: 'v0.3.0',
    published_at: '2026-11-01T00:00:00Z',
    prerelease: false,
    draft: false,
    body: '',
    html_url: 'https://github.com/someone/MMPort/releases/tag/v0.3.0',
    assets: [
      {
        name: 'MMPort-v0.3.0-windows-x64.zip',
        size: 1000,
        browser_download_url: 'https://github.com/someone/MMPort/releases/download/v0.3.0/x.zip'
      }
    ]
  }
]

/** A metadata cloud that records what it was asked and answers `answer`. */
class FakeCloud implements RecompCloudLink {
  list: CloudRecomp[] = []
  sent: string[] = []
  withdrawn: string[] = []
  answer: RecompSendResult = { state: 'queued' }
  /** Run while a submit is under way (a flush delivering the same add meanwhile). */
  during: (() => void) | null = null
  queued: string[] = []
  sending = true
  private listeners = new Set<() => void>()
  delivered = new Set<
    (id: string, state: AddedRecompState, prUrl?: string, refused?: string) => void
  >()
  sendingOn = new Set<() => void>()
  cloudRecomps(): CloudRecomp[] {
    return this.list
  }
  onCloudRecomps(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  setList(list: CloudRecomp[]): void {
    this.list = list
    for (const l of this.listeners) l()
  }
  async submitRecomp(input: { id: string }): Promise<RecompSendResult> {
    this.sent.push(input.id)
    this.during?.()
    await new Promise((r) => setTimeout(r, 20))
    return this.answer
  }
  withdrawRecomp(id: string): void {
    this.withdrawn.push(id)
  }
  onRecompDelivered(
    listener: (id: string, state: AddedRecompState, prUrl?: string, refused?: string) => void
  ): () => void {
    this.delivered.add(listener)
    return () => this.delivered.delete(listener)
  }
  onSendingRecomps(listener: () => void): () => void {
    this.sendingOn.add(listener)
    return () => this.sendingOn.delete(listener)
  }
  turnSendingOn(): void {
    this.sending = true
    for (const l of this.sendingOn) l()
  }
  sendsRecomps(): boolean {
    return this.sending
  }
  queuedRecompIds(): string[] {
    return this.queued
  }
}

let tmp: string
let services: RecompService[] = []
beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'playout-recomp-add-'))
})
afterEach(async () => {
  for (const s of services) s.dispose()
  services = []
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

function service(over: Partial<RecompServiceDeps> = {}): {
  s: RecompService
  loads: () => number
  trashed: string[]
} {
  let loads = 0
  const trashed: string[] = []
  const s = createRecompService({
    userData: join(tmp, 'userData'),
    exeDir: tmp,
    root: join(tmp, 'Recompilations'),
    library: library(),
    launcher: { track: () => {}, running: () => null },
    events: { emit: () => {} },
    dialog: { chooseFile: async () => null, chooseFolder: async () => null },
    openPath: async () => {},
    log,
    fetch: github,
    loadCatalog: async () => {
      loads++
      return catalog()
    },
    fetchReleases: async () => releases,
    fetchReadme: async () => '',
    uninstall: async () => {
      throw new Error('uninstall is not used when the Recycle Bin is there')
    },
    trash: async (path) => {
      trashed.push(path)
      await fs.rm(path, { recursive: true, force: true })
    },
    emulationDir: () => join(tmp, 'Emulation'),
    machine: 'TEST-PC',
    startDelayMs: 60_000,
    ...over
  })
  services.push(s)
  return { s, loads: () => loads, trashed }
}

async function addMine(s: RecompService, game = GAME): Promise<{ id: string; titleKey: string }> {
  const check = await s.checkRecompRepo('https://github.com/someone/mmport')
  expect(check).toMatchObject({ ok: true, repo: 'someone/MMPort', fork: true })
  return s.addRecomp({ id: MINE, game, systemId: 'n64' })
}

function installedRecord(id: string, dir: string): InstalledRecomp {
  const at = '2026-11-01T00:00:00.000Z'
  return {
    id,
    dir,
    tag: 'v0.3.0',
    asset: 'x.zip',
    downloadBytes: 1,
    diskBytes: 1,
    sha256: 'ab'.repeat(32),
    verified: 'github',
    exe: 'MMPort.exe',
    installedAt: at,
    updatedAt: at,
    releaseFiles: ['mmport.exe'],
    autoUpdate: false,
    gameFiles: {},
    savePaths: [],
    saveSource: null,
    cloud: defaultCloudState(),
    prevTag: null
  }
}

describe('adding a recompilation in the browser', () => {
  it('adds a checked repository to its game, shown as added by you and never as new', async () => {
    const { s } = service()
    await expect(s.addRecomp({ id: MINE, game: GAME, systemId: 'n64' })).rejects.toThrow()
    const added = await addMine(s)
    expect(added).toEqual({ id: MINE, titleKey: KEY })
    const view = await s.browseRecomps()
    const title = view.titles.find((t) => t.key === KEY)!
    const mine = title.entries.find((e) => e.id === MINE)!
    expect(mine).toMatchObject({
      name: 'MMPort',
      repo: 'someone/MMPort',
      added: 'local',
      awaiting: false,
      isNew: false,
      installed: false,
      blurb: 'Majora’s Mask on PC.'
    })
    expect(view.newCount).toBe(0)
    const stored = await readAdded(join(tmp, 'userData'))
    expect(stored).toMatchObject([
      { id: MINE, repo: 'someone/MMPort', game: GAME, systemId: 'n64', state: 'local', fork: true }
    ])
    // Listed now: a second check says so, with the recompilation to show.
    expect(await s.checkRecompRepo('someone/MMPort')).toMatchObject({
      ok: false,
      reason: 'alreadyListed',
      existingId: MINE
    })
  })

  it('refuses a repository a catalog lists, and bad input', async () => {
    const { s } = service({
      fetch: (async () =>
        new Response(
          JSON.stringify({
            full_name: 'Zelda64/Zelda64Recomp',
            private: false,
            visibility: 'public'
          }),
          { status: 200 }
        )) as typeof fetch
    })
    expect(await s.checkRecompRepo('zelda64/zelda64recomp')).toMatchObject({
      reason: 'alreadyListed',
      existingId: ZELDA
    })
    const { s: s2 } = service()
    await s2.checkRecompRepo('someone/mmport')
    await expect(s2.addRecomp({ id: MINE, game: '  ', systemId: 'n64' })).rejects.toThrow()
    await expect(s2.addRecomp({ id: MINE, game: 'x', systemId: 'nope' })).rejects.toThrow()
  })

  it('sends the add through the metadata cloud and notes how far it got', async () => {
    const cloud = new FakeCloud()
    cloud.answer = {
      state: 'suggested',
      prUrl: 'https://github.com/jeremybris/PlayOut-metadata/pull/5'
    }
    const { s } = service({ cloud })
    s.start()
    await addMine(s)
    await vi.waitFor(async () => {
      const stored = await readAdded(join(tmp, 'userData'))
      expect(stored[0]).toMatchObject({
        state: 'suggested',
        prUrl: 'https://github.com/jeremybris/PlayOut-metadata/pull/5'
      })
    })
    expect(cloud.sent).toEqual([MINE])
    const view = await s.browseRecomps()
    const mine = view.titles.flatMap((t) => t.entries).find((e) => e.id === MINE)!
    expect(mine).toMatchObject({ added: 'suggested', awaiting: true })
    // A flush later publishes it (the owner, or an approval seen as 409).
    for (const l of cloud.delivered) l(MINE, 'published')
    await vi.waitFor(async () =>
      expect((await readAdded(join(tmp, 'userData')))[0]?.state).toBe('published')
    )
  })

  it("shows PlayOut's list, and tidies an add away once the list carries it (an install keeps its id)", async () => {
    const cloud = new FakeCloud()
    cloud.sending = false
    const { s } = service({ cloud })
    s.start()
    await addMine(s)
    expect((await readAdded(join(tmp, 'userData')))[0]?.state).toBe('local')
    cloud.setList([
      {
        id: MINE,
        repo: 'someone/MMPort',
        repoUrl: 'https://github.com/someone/MMPort',
        game: GAME,
        systemId: 'n64',
        blurb: 'Approved.',
        addedAt: '2026-11-27T00:00:00.000Z'
      },
      {
        id: 'github:other/sonic',
        repo: 'other/Sonic',
        repoUrl: 'https://github.com/other/Sonic',
        game: 'Sonic the Hedgehog',
        systemId: 'genesis',
        blurb: '',
        addedAt: null
      }
    ])
    await vi.waitFor(async () => expect(await readAdded(join(tmp, 'userData'))).toEqual([]))
    const view = await s.browseRecomps()
    const mine = view.titles.flatMap((t) => t.entries).find((e) => e.id === MINE)!
    expect(mine.added).toBeUndefined()
    expect(mine.blurb).toBe('Approved.')
    expect(view.titles.some((t) => t.game === 'Sonic the Hedgehog')).toBe(true)
  })

  it('still retries the catalogs when they could not be loaded, whatever was added', async () => {
    let empty = true
    let loads = 0
    const { s } = service({
      loadCatalog: async () => {
        loads++
        return catalog(empty)
      }
    })
    await addMine(s)
    const before = loads
    await s.browseRecomps()
    expect(loads).toBeGreaterThan(before)
    // The add shows meanwhile, in a title of its own.
    expect((await s.browseRecomps()).titles.flatMap((t) => t.entries).map((e) => e.id)).toContain(
      MINE
    )
    empty = false
    await s.browseRecomps()
    const settled = loads
    await s.browseRecomps()
    expect(loads).toBe(settled)
  })

  it('removes an add: an installed one goes to the Recycle Bin when asked, else it stays installed', async () => {
    // Installed before the service reads its state (it keeps what it read).
    const root = join(tmp, 'Recompilations')
    const dir = join(root, 'MMPort')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'MMPort.exe'), 'MZ')
    await createRecompState(root).update((m) => {
      m.installed[MINE] = installedRecord(MINE, dir)
    })
    const cloud = new FakeCloud()
    const { s, trashed } = service({ cloud })
    await addMine(s)
    // Keep it installed.
    await s.removeAddedRecomp(MINE, false)
    expect(trashed).toEqual([])
    expect(cloud.withdrawn).toEqual([MINE])
    expect((await s.getRecompSettings()).rows.map((r) => r.installed.id)).toEqual([MINE])
    await expect(s.removeAddedRecomp(MINE, true)).rejects.toThrow()
    // Added again, then removed with its install.
    await addMine(s)
    await s.removeAddedRecomp(MINE, true)
    expect(trashed).toEqual([dir])
    expect((await s.getRecompSettings()).rows).toEqual([])
    expect(await readAdded(join(tmp, 'userData'))).toEqual([])
  })

  it('moves an install to the catalog entry once a catalog lists the repository under one game id', async () => {
    let listed = false
    const slug = `${MINE}#majoras-mask`
    const root = join(tmp, 'Recompilations')
    await createRecompState(root).update((m) => {
      m.installed[MINE] = installedRecord(MINE, join(root, 'MMPort'))
    })
    const { s } = service({
      loadCatalog: async () => {
        const c = catalog()
        if (listed) {
          const e: RecompEntry = {
            ...stubEntry(slug, null),
            game: GAME,
            systemId: 'n64',
            sources: ['decomp-buddy']
          }
          c.entries.set(slug, e)
          c.titles.get(KEY)!.entries.push(slug)
          c.byRepo.set(MINE, [slug])
        }
        return c
      }
    })
    await addMine(s)
    listed = true
    await s.refreshRecompCatalog()
    const m = await createRecompState(root).read()
    expect(Object.keys(m.installed)).toEqual([slug])
    expect(m.installed[slug]!.id).toBe(slug)
  })

  it('refuses a game name with HTML or a script link: never stored, never sent', async () => {
    const cloud = new FakeCloud()
    const { s } = service({ cloud })
    await s.checkRecompRepo('someone/mmport')
    for (const game of [
      '<b>Zelda</b>',
      '<img src=x onerror=alert(1)> Zelda',
      'javascript:alert(1)'
    ])
      await expect(s.addRecomp({ id: MINE, game, systemId: 'n64' }), game).rejects.toThrow()
    expect(await readAdded(join(tmp, 'userData'))).toEqual([])
    expect(cloud.sent).toEqual([])
  })

  it('keeps what a flush noted while the add was being sent (never back to local)', async () => {
    for (const answer of [{ state: null }, { state: 'local' }, { state: 'queued' }] as const) {
      await fs.rm(join(tmp, 'userData'), { recursive: true, force: true })
      const cloud = new FakeCloud()
      // A flush delivers the same add meanwhile and tells the listeners; submit's own answer comes later.
      cloud.during = () => {
        for (const l of cloud.delivered) l(MINE, 'suggested', 'https://github.com/o/r/pull/9')
      }
      cloud.answer = answer
      const { s } = service({ cloud })
      s.start()
      await addMine(s)
      await vi.waitFor(async () =>
        expect((await readAdded(join(tmp, 'userData')))[0]?.state, String(answer.state)).toBe(
          'suggested'
        )
      )
      await new Promise((r) => setTimeout(r, 60))
      expect((await readAdded(join(tmp, 'userData')))[0], String(answer.state)).toMatchObject({
        state: 'suggested',
        prUrl: 'https://github.com/o/r/pull/9'
      })
      s.dispose()
    }
  })

  it('shows an add that was refused, or not sent while sending was off, and sends the latter once it is on', async () => {
    // Refused by the suggestion service: kept, marked, never sent again.
    const refusing = new FakeCloud()
    refusing.answer = { state: 'local', refused: 'the repository has no release with a download' }
    const one = service({ cloud: refusing })
    one.s.start()
    await addMine(one.s)
    await vi.waitFor(async () =>
      expect((await readAdded(join(tmp, 'userData')))[0]?.refused).toBe(
        'the repository has no release with a download'
      )
    )
    const shown = (await one.s.browseRecomps()).titles
      .flatMap((t) => t.entries)
      .find((e) => e.id === MINE)!
    expect(shown).toMatchObject({
      added: 'local',
      notSent: 'refused',
      refusedReason: 'the repository has no release with a download'
    })
    one.s.dispose()
    // Restarted with sending on: a refused add is not sent again.
    const again = new FakeCloud()
    const two = service({ cloud: again })
    two.s.start()
    await new Promise((r) => setTimeout(r, 60))
    expect(again.sent).toEqual([])
    two.s.dispose()

    // Sending off: 'local' without a reason, sent once sending is switched on.
    await fs.rm(join(tmp, 'userData'), { recursive: true, force: true })
    const off = new FakeCloud()
    off.sending = false
    const three = service({ cloud: off })
    three.s.start()
    await addMine(three.s)
    const before = (await three.s.browseRecomps()).titles
      .flatMap((t) => t.entries)
      .find((e) => e.id === MINE)!
    expect(before).toMatchObject({ added: 'local', notSent: 'off' })
    expect(off.sent).toEqual([])
    off.answer = { state: 'suggested', prUrl: 'https://github.com/o/r/pull/3' }
    off.turnSendingOn()
    await vi.waitFor(async () =>
      expect((await readAdded(join(tmp, 'userData')))[0]?.state).toBe('suggested')
    )
    expect(off.sent).toEqual([MINE])
    const after = (await three.s.browseRecomps()).titles
      .flatMap((t) => t.entries)
      .find((e) => e.id === MINE)!
    expect(after.notSent).toBeUndefined()
  })

  it('marks an added recompilation as never scanned, and a catalog one not', async () => {
    const { s } = service()
    await addMine(s)
    const entries = (await s.browseRecomps()).titles.flatMap((t) => t.entries)
    expect(entries.find((e) => e.id === MINE)?.unscanned).toBe(true)
    expect(entries.find((e) => e.id === ZELDA)?.unscanned).toBeUndefined()
  })

  it('never marks a recompilation this PC added as New once PlayOut’s list carries it', async () => {
    let clock = Date.parse('2026-11-20T00:00:00.000Z')
    const cloud = new FakeCloud()
    cloud.sending = false
    const { s } = service({ cloud, now: () => new Date(clock) })
    s.start()
    // The first complete catalog check sets the baseline.
    await addMine(s)
    clock += 3_600_000
    cloud.setList([
      {
        id: MINE,
        repo: 'someone/MMPort',
        repoUrl: 'https://github.com/someone/MMPort',
        game: GAME,
        systemId: 'n64',
        blurb: '',
        addedAt: '2026-11-20T01:00:00.000Z'
      }
    ])
    await vi.waitFor(async () => expect(await readAdded(join(tmp, 'userData'))).toEqual([]))
    clock += 3_600_000
    await s.refreshRecompCatalog()
    const view = await s.browseRecomps()
    expect(view.titles.flatMap((t) => t.entries).find((e) => e.id === MINE)?.isNew).toBe(false)
    expect(view.newCount).toBe(0)
  })

  it('Remove with uninstall clears what Uninstall clears (a half-done update, the cached download)', async () => {
    const root = join(tmp, 'Recompilations')
    const dir = join(root, 'MMPort')
    const cache = join(root, '.playout', 'cache', 'downloads', 'someone-mmport')
    await fs.mkdir(dir, { recursive: true })
    await fs.mkdir(`${dir}.staging`, { recursive: true })
    await fs.mkdir(cache, { recursive: true })
    await fs.writeFile(join(cache, 'x.zip'), 'zip')
    await createRecompState(root).update((m) => {
      m.installed[MINE] = installedRecord(MINE, dir)
    })
    const { s, trashed } = service()
    await addMine(s)
    await s.removeAddedRecomp(MINE, true)
    expect(trashed).toEqual([dir])
    await expect(fs.stat(`${dir}.staging`)).rejects.toThrow()
    await expect(fs.stat(cache)).rejects.toThrow()
  })

  it('reads the clipboard for Paste, trimmed and capped', async () => {
    const { s } = service({ clipboardText: async () => `  ${'x'.repeat(5000)}  ` })
    expect(await s.readRecompClipboard()).toHaveLength(2048)
  })
})
