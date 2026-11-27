import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { InstalledRecomp, RecompEntry, RecompImportProgress } from '../../shared/recomp'
import type { RecompCatalog } from './catalog'
import { safeRecompFolder } from './install'
import { createRecompImporter, type ImportProcess, type ImportRunDeps } from './import-run'
import type { GhRelease } from './releases'
import { stubEntry, versionUnknown } from './service'
import { createRecompState, defaultCloudState, recompPlayoutDir, type RecompState } from './state'
import { stagingDir } from '../emulation/emulation-move'

const noop = (): void => undefined
let tmp: string
let root: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'recomp-import-run-'))
  root = join(tmp, 'Recompilations')
  await fs.mkdir(root, { recursive: true })
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function file(path: string, text = 'x'): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, text)
}
const exists = (p: string): Promise<boolean> =>
  fs.lstat(p).then(
    () => true,
    () => false
  )

const SKATE = 'github:someone/skate1recompiled'
const ZELDA = 'github:zelda64recomp/zelda64recomp'
const SHA = 'b'.repeat(64)

function entry(id: string, repo: string, name: string): RecompEntry {
  return { ...stubEntry(id, null), repo, name, game: name }
}
const entries = [
  entry(SKATE, 'someone/Skate1Recompiled', 'Skate 1 Recompiled'),
  entry(ZELDA, 'Zelda64Recomp/Zelda64Recomp', 'Zelda 64 Recompiled')
]
const catalog: RecompCatalog = {
  entries: new Map(entries.map((e) => [e.id, e])),
  titles: new Map(),
  byRepo: new Map(entries.map((e) => [`github:${e.repo}`.toLowerCase(), [e.id]])),
  byRl: new Map([['zelda64recomp', [ZELDA]]]),
  fetchedAt: { 'decomp-buddy': null, recomplauncher: null },
  offline: []
}
const release = (tag: string, asset: string, sha: string): GhRelease => ({
  tag_name: tag,
  name: tag,
  published_at: '2026-10-02T00:00:00Z',
  prerelease: false,
  draft: false,
  body: null,
  html_url: '',
  assets: [
    { name: asset, size: 1234, browser_download_url: 'https://x/y.zip', digest: `sha256:${sha}` }
  ]
})

/** A Quiver Launcher folder with Skate installed (and the program the player chose). */
async function quiverSkate(): Promise<{ quiverRoot: string; folder: string }> {
  const quiverRoot = join(tmp, 'Desktop', 'Quiver Launcher')
  await file(join(quiverRoot, 'QuiverLauncher.exe'))
  await file(
    join(quiverRoot, 'apps.json'),
    JSON.stringify({
      apps: [
        {
          name: 'Skate',
          folderName: 'Skate-Skate1Recompiled',
          repository: 'someone/Skate1Recompiled'
        }
      ]
    })
  )
  const folder = join(quiverRoot, 'apps', 'Skate-Skate1Recompiled')
  await file(join(folder, 'skate1.exe'), 'game')
  await file(join(folder, 'userdata', 'save.dat'), 'my save')
  await file(join(folder, 'version.txt'), 'v0.2.0')
  await file(join(folder, 'installed-build.txt'), `Skate1-PC-v0.2.0.zip\n${SHA}`)
  await file(join(folder, 'selected_executable.txt'), join(folder, 'skate1.exe'))
  return { quiverRoot, folder }
}

/** A RecompLauncher library with Zelda installed (it records no version). */
async function rlZelda(): Promise<string> {
  const lib = join(tmp, 'Recomp Library')
  await fs.mkdir(join(lib, '.staging'), { recursive: true })
  const folder = join(lib, 'zelda64recomp')
  await file(join(folder, 'Zelda64Recompiled.exe'), 'zelda')
  await file(join(folder, 'saves', 'slot1.bin'), 'save')
  return folder
}

function setup(over: Partial<ImportRunDeps> = {}): {
  importer: ReturnType<typeof createRecompImporter>
  state: RecompState
  events: RecompImportProgress[]
  afterImport: ReturnType<typeof vi.fn>
  procs: ImportProcess[]
} {
  const state = createRecompState(root)
  const events: RecompImportProgress[] = []
  const afterImport = vi.fn(async () => undefined)
  const procs: ImportProcess[] = []
  const importer = createRecompImporter({
    root: async () => root,
    state: async () => state,
    catalog: () => catalog,
    busy: () => false,
    processes: async () => procs,
    releasesOf: async (e) =>
      e.id === SKATE
        ? [
            release('v0.2.0', 'Skate1-PC-v0.2.0.zip', SHA),
            release('v0.3.0', 'Skate1-PC-v0.3.0.zip', 'c'.repeat(64))
          ]
        : [release('v1.2.2', 'z.zip', SHA)],
    readProfile: async () => null,
    afterImport,
    emit: (p) => events.push(p),
    log: { debug: noop, info: noop, warn: noop, error: noop },
    freeSpace: async () => null,
    ...over
  })
  return { importer, state, events, afterImport, procs }
}

describe('recomp import: preview', () => {
  it('lists what it found with the pick, the version, the size and where it goes; nothing moves', async () => {
    const { folder } = await quiverSkate()
    const zelda = await rlZelda()
    const { importer } = setup()
    const scan = await importer.scan([
      join(tmp, 'Desktop', 'Quiver Launcher'),
      join(tmp, 'Recomp Library')
    ])
    expect(scan.items.map((i) => [i.launcher, i.match, i.recompId, i.version])).toEqual([
      ['quiver', 'repo', SKATE, 'v0.2.0'],
      ['recomplauncher', 'launcher-id', ZELDA, null]
    ])
    const skate = scan.items[0]!
    expect(skate.bytes).toBeGreaterThan(0)
    expect(skate.choices[0]).toMatchObject({
      installed: false,
      targetTaken: false,
      target: join(root, safeRecompFolder(entries[0]!))
    })
    expect(scan.items[1]!.notes.join(' ')).toMatch(/Version unknown/)
    expect(scan.catalog.map((c) => c.id).sort()).toEqual([SKATE, ZELDA].sort())
    expect(await exists(folder)).toBe(true)
    expect(await exists(zelda)).toBe(true)
  })

  it('refuses a folder a running program was started from, and while the other launcher is open', async () => {
    const { folder } = await quiverSkate()
    const { importer, procs } = setup()
    procs.push({ name: 'skate1.exe', path: join(folder, 'skate1.exe') })
    let scan = await importer.scan([folder])
    expect(scan.items[0]!.blocked).toMatch(/skate1\.exe is running/)
    procs.splice(0, 1, { name: 'QuiverLauncher.exe', path: 'C:\\elsewhere\\QuiverLauncher.exe' })
    scan = await importer.scan([folder])
    expect(scan.items[0]!.blocked).toMatch(/Quiver Launcher is open/)
    // The move checks again: still refused, nothing moved.
    const result = await importer.run([{ folder, recompId: SKATE }])
    expect(result.failed[0]!.message).toMatch(/Quiver Launcher is open/)
    expect(await exists(folder)).toBe(true)
  })

  it('never takes the Recompilations folder or what is in it', async () => {
    await file(
      join(root, 'Other (x)', 'decomp-buddy.json'),
      JSON.stringify({ repo: 'a/b', target: 'windows' })
    )
    const { importer } = setup()
    expect((await importer.scan([root])).items).toEqual([])
    expect((await importer.scan([join(root, 'Other (x)')])).items).toEqual([])
  })
})

describe('recomp import: moving', () => {
  it("same drive: renames the folder in, writes the record, keeps the player's choice and saves, updates settings files", async () => {
    const { folder } = await quiverSkate()
    const { importer, state, events, afterImport } = setup()
    await importer.scan([folder])
    const result = await importer.run([{ folder, recompId: SKATE }])
    const target = join(root, safeRecompFolder(entries[0]!))
    expect(result.failed).toEqual([])
    expect(result.imported).toEqual([
      expect.objectContaining({
        recompId: SKATE,
        dir: target,
        renamed: true,
        leftInOld: 0,
        versionKnown: true
      })
    ])
    expect(await exists(folder)).toBe(false)
    expect(await fs.readFile(join(target, 'userdata', 'save.dat'), 'utf8')).toBe('my save')
    const rec = (await state.read()).installed[SKATE]!
    expect(rec).toMatchObject({
      dir: target,
      tag: 'v0.2.0',
      publishedAt: '2026-10-02T00:00:00Z',
      asset: 'Skate1-PC-v0.2.0.zip',
      sha256: SHA,
      verified: 'github',
      exe: 'skate1.exe',
      exeChosen: 'user',
      autoExe: 'skate1.exe',
      releaseFiles: [],
      autoUpdate: false,
      cloud: defaultCloudState(),
      imported: { from: 'quiver', fromDir: folder, versionKnown: true }
    })
    expect(await fs.readFile(join(target, 'selected_executable.txt'), 'utf8')).toBe(
      join(target, 'skate1.exe')
    )
    expect(afterImport).toHaveBeenCalledWith([SKATE])
    expect(events.at(-1)).toMatchObject({ phase: 'done', index: 1, total: 1 })
    expect(await exists(join(recompPlayoutDir(root), 'import-journal.json'))).toBe(false)
  })

  it('a version PlayOut cannot find among the releases is recorded as unknown', async () => {
    const zelda = await rlZelda()
    const { importer, state } = setup()
    await importer.scan([zelda])
    const result = await importer.run([{ folder: zelda, recompId: ZELDA }])
    expect(result.imported[0]!.versionKnown).toBe(false)
    const rec = (await state.read()).installed[ZELDA]!
    expect(rec.tag).toBe('')
    expect(rec.exe).toBe('Zelda64Recompiled.exe')
    expect(rec.verified).toBe('unverified')
    expect(versionUnknown(rec)).toBe(true)
    expect(versionUnknown({ imported: { ...rec.imported!, versionKnown: true } })).toBe(false)
    expect(versionUnknown({})).toBe(false)
  })

  it('another drive: copies, checks, records, then deletes the old folder', async () => {
    const zelda = await rlZelda()
    const rename = vi.fn(async (from: string, to: string) => {
      if (from === zelda) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      await fs.rename(from, to)
    })
    const { importer, state, events } = setup({ rename })
    await importer.scan([zelda])
    const result = await importer.run([{ folder: zelda, recompId: ZELDA }])
    expect(result.failed).toEqual([])
    expect(result.imported[0]).toMatchObject({ renamed: false, leftInOld: 0 })
    const target = (await state.read()).installed[ZELDA]!.dir
    expect(await fs.readFile(join(target, 'saves', 'slot1.bin'), 'utf8')).toBe('save')
    expect(await exists(zelda)).toBe(false)
    expect(await exists(stagingDir(target))).toBe(false)
    expect(events.map((e) => e.phase)).toEqual(
      expect.arrayContaining(['copying', 'verifying', 'switching'])
    )
  })

  it('another drive without room: nothing is copied', async () => {
    const zelda = await rlZelda()
    const rename = async (from: string, to: string): Promise<void> => {
      if (from === zelda) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      await fs.rename(from, to)
    }
    const { importer, state } = setup({ rename, freeSpace: async () => 10 })
    await importer.scan([zelda])
    const result = await importer.run([{ folder: zelda, recompId: ZELDA }])
    expect(result.failed[0]!.message).toMatch(/Not enough free space/)
    expect(await exists(zelda)).toBe(true)
    expect((await state.read()).installed[ZELDA]).toBeUndefined()
  })

  it('a record that cannot be written puts the folder back (same drive and another drive)', async () => {
    for (const crossDrive of [false, true]) {
      const zelda = await rlZelda()
      const real = createRecompState(root)
      const failing: RecompState = {
        read: () => real.read(),
        update: async () => {
          throw new Error('disk full')
        }
      }
      const rename = async (from: string, to: string): Promise<void> => {
        if (crossDrive && from === zelda) throw Object.assign(new Error('x'), { code: 'EXDEV' })
        await fs.rename(from, to)
      }
      const { importer } = setup({ state: async () => failing, rename })
      await importer.scan([zelda])
      const result = await importer.run([{ folder: zelda, recompId: ZELDA }])
      expect(result.failed[0]!.message).toBe('disk full')
      expect(await fs.readFile(join(zelda, 'saves', 'slot1.bin'), 'utf8')).toBe('save')
      const target = join(root, safeRecompFolder(entries[1]!))
      expect(await exists(target)).toBe(false)
      expect(await exists(stagingDir(target))).toBe(false)
      expect(await exists(join(recompPlayoutDir(root), 'import-journal.json'))).toBe(false)
    }
  })

  it('never over an install: already installed, or something in the target folder', async () => {
    const zelda = await rlZelda()
    const { importer, state } = setup()
    await state.update((m) => {
      m.installed[ZELDA] = { id: ZELDA, dir: join(tmp, 'elsewhere'), tag: 'v1' } as InstalledRecomp
    })
    let scan = await importer.scan([zelda])
    expect(scan.items[0]!.choices[0]!.installed).toBe(true)
    let result = await importer.run([{ folder: zelda, recompId: ZELDA }])
    expect(result.failed[0]!.message).toMatch(/already installed/)
    expect(await exists(zelda)).toBe(true)

    await state.update((m) => {
      delete m.installed[ZELDA]
    })
    const target = join(root, safeRecompFolder(entries[1]!))
    await file(join(target, 'someone-elses.txt'))
    scan = await importer.scan([zelda])
    expect(scan.items[0]!.choices[0]!.targetTaken).toBe(true)
    result = await importer.run([{ folder: zelda, recompId: ZELDA }])
    expect(result.failed[0]!.message).toMatch(/Something is already in/)
    expect(await exists(join(zelda, 'Zelda64Recompiled.exe'))).toBe(true)
    expect(await fs.readdir(target)).toEqual(['someone-elses.txt'])
  })

  it('only moves folders from the last preview, each recompilation once', async () => {
    const zelda = await rlZelda()
    const { folder } = await quiverSkate()
    const { importer } = setup()
    let result = await importer.run([{ folder: zelda, recompId: ZELDA }])
    expect(result.failed[0]!.message).toMatch(/not in the list/)
    await importer.scan([zelda, folder])
    result = await importer.run([
      { folder: zelda, recompId: ZELDA },
      { folder, recompId: ZELDA }
    ])
    expect(result.imported).toHaveLength(1)
    expect(result.failed[0]!.message).toMatch(/chosen for two folders/)
    expect(await exists(folder)).toBe(true)
  })

  it('Stop: what was not started stays where it is', async () => {
    const zelda = await rlZelda()
    const { folder } = await quiverSkate()
    let importerRef: ReturnType<typeof createRecompImporter> | null = null
    const { importer } = setup({
      releasesOf: async () => {
        importerRef!.cancel()
        return []
      }
    })
    importerRef = importer
    await importer.scan([zelda, folder])
    // Skate's release is looked up (and Stop pressed meanwhile) before anything moves.
    const result = await importer.run([
      { folder, recompId: SKATE },
      { folder: zelda, recompId: ZELDA }
    ])
    expect(result.imported).toEqual([])
    expect(result.notStarted).toEqual([folder, zelda])
    expect(await exists(zelda)).toBe(true)
    expect(await exists(folder)).toBe(true)
  })
})

describe('recomp import: an interrupted import', () => {
  it('puts a renamed folder back, removes a partial copy, finishes a recorded one', async () => {
    const zelda = await rlZelda()
    const renamedTo = join(root, 'Zelda (z)')
    await fs.rename(zelda, renamedTo)
    const stage = stagingDir(join(root, 'Copy (c)'))
    await file(join(stage, 'half.bin'))
    const copiedFrom = join(tmp, 'Old Copy')
    const copiedTo = join(root, 'Done (d)')
    await file(join(copiedFrom, 'same.bin'), 'same')
    await file(join(copiedTo, 'same.bin'), 'same')
    const t = (await fs.stat(join(copiedFrom, 'same.bin'))).mtime
    await fs.utimes(join(copiedTo, 'same.bin'), t, t)
    const state = createRecompState(root)
    await state.update((m) => {
      m.installed[SKATE] = { id: SKATE, dir: copiedTo, tag: 'v1' } as InstalledRecomp
    })
    await fs.mkdir(recompPlayoutDir(root), { recursive: true })
    await fs.writeFile(
      join(recompPlayoutDir(root), 'import-journal.json'),
      JSON.stringify({
        version: 1,
        entries: [
          { from: zelda, to: renamedTo, recompId: ZELDA, phase: 'renamed', since: Date.now() },
          {
            from: join(tmp, 'gone'),
            to: join(root, 'Copy (c)'),
            recompId: 'github:a/b',
            phase: 'copying',
            since: Date.now()
          },
          { from: copiedFrom, to: copiedTo, recompId: SKATE, phase: 'cleaning', since: 0 }
        ]
      })
    )
    const { importer } = setup({ state: async () => state })
    await importer.recover()
    expect(await exists(join(zelda, 'Zelda64Recompiled.exe'))).toBe(true)
    expect(await exists(renamedTo)).toBe(false)
    expect(await exists(stage)).toBe(false)
    expect(await exists(join(copiedFrom, 'same.bin'))).toBe(false)
    expect(await fs.readFile(join(copiedTo, 'same.bin'), 'utf8')).toBe('same')
    expect(await exists(join(recompPlayoutDir(root), 'import-journal.json'))).toBe(false)
  })
})

describe('recomp import: review fixes', () => {
  const journalFile = (): string => join(recompPlayoutDir(root), 'import-journal.json')
  const zeldaTarget = (): string => join(root, safeRecompFolder(entries[1]!))
  const readJournalFile = async (): Promise<{ from: string; phase: string }[]> =>
    (await exists(journalFile()))
      ? (JSON.parse(await fs.readFile(journalFile(), 'utf8')) as { entries: [] }).entries
      : []
  const waitFor = async (ok: () => boolean): Promise<void> => {
    for (let i = 0; i < 250 && !ok(); i++) await new Promise((r) => setTimeout(r, 20))
    expect(ok()).toBe(true)
  }

  it('an import waits for the start-up recovery, which never removes its journal entry', async () => {
    const zelda = await rlZelda()
    await file(
      journalFile(),
      JSON.stringify({
        version: 1,
        entries: [
          {
            from: join(tmp, 'gone'),
            to: join(root, 'Old (o)'),
            recompId: 'github:a/b',
            phase: 'copying',
            since: Date.now()
          }
        ]
      })
    )
    const real = createRecompState(root)
    let releaseRecover!: () => void
    const gate = new Promise<void>((r) => (releaseRecover = r))
    let hold = false
    const st = {
      ...real,
      read: async () => {
        if (hold) {
          hold = false
          await gate
        }
        return real.read()
      }
    } as RecompState
    let renamed = false
    const { importer } = setup({
      state: async () => st,
      rename: async (a, b) => {
        renamed = true
        await fs.rename(a, b)
      }
    })
    await importer.scan([zelda])
    hold = true
    const recovering = importer.recover()
    await new Promise((r) => setTimeout(r, 30))
    const running = importer.run([{ folder: zelda, recompId: ZELDA }])
    await new Promise((r) => setTimeout(r, 60))
    // Nothing moves while the recovery runs.
    expect(renamed).toBe(false)
    releaseRecover()
    await recovering
    const result = await running
    expect(result.imported).toHaveLength(1)
    expect((await real.read()).installed[ZELDA]?.dir).toBe(zeldaTarget())
    expect(await readJournalFile()).toEqual([])
  })

  it('recovery keeps the journal entries it could not finish', async () => {
    const from = join(tmp, 'Lib', 'kept')
    const to = join(root, 'Kept (k)')
    await file(join(from, 'other.txt'), 'something else made here')
    await file(join(to, 'game.exe'), 'MZ')
    await file(
      journalFile(),
      JSON.stringify({
        version: 1,
        entries: [{ from, to, recompId: 'github:not/known', phase: 'renamed', since: Date.now() }]
      })
    )
    const { importer } = setup()
    await importer.recover()
    expect(await readJournalFile()).toHaveLength(1)
    expect(await exists(join(to, 'game.exe'))).toBe(true)
    expect(await exists(join(from, 'other.txt'))).toBe(true)
  })

  /** An import stopped while it records the install (PlayOut closed then): the folder stands renamed. */
  async function interrupted(zelda: string): Promise<void> {
    let hung = false
    const first = setup({
      readProfile: () => {
        hung = true
        return new Promise<null>(() => undefined)
      }
    })
    await first.importer.scan([zelda])
    void first.importer.run([{ folder: zelda, recompId: ZELDA }]).catch(() => undefined)
    await waitFor(() => hung)
    expect(await exists(zeldaTarget())).toBe(true)
  }

  it("recovery puts a renamed folder back over the launcher's placeholder", async () => {
    const zelda = await rlZelda()
    await interrupted(zelda)
    await file(join(zelda, 'Place app files here.txt'), '')
    const { importer, state } = setup()
    await importer.recover()
    expect(await fs.readFile(join(zelda, 'saves', 'slot1.bin'), 'utf8')).toBe('save')
    expect(await exists(join(zelda, 'Place app files here.txt'))).toBe(false)
    expect(await exists(zeldaTarget())).toBe(false)
    expect((await state.read()).installed[ZELDA]).toBeUndefined()
    expect(await readJournalFile()).toEqual([])
  })

  it('recovery records a renamed folder where it is when its old place holds something else now', async () => {
    const zelda = await rlZelda()
    await interrupted(zelda)
    await file(join(zelda, 'new-install', 'game.exe'), 'MZ')
    const { importer, state } = setup()
    await importer.recover()
    const rec = (await state.read()).installed[ZELDA]
    expect(rec?.dir).toBe(zeldaTarget())
    expect(rec?.imported?.from).toBe('recomplauncher')
    expect(await fs.readFile(join(zeldaTarget(), 'saves', 'slot1.bin'), 'utf8')).toBe('save')
    expect(await exists(join(zelda, 'new-install', 'game.exe'))).toBe(true)
    expect(await readJournalFile()).toEqual([])
  })

  it('recovery points the links of a folder it puts back at it again', async () => {
    const zelda = await rlZelda()
    await fs.symlink(join(zelda, 'saves'), join(zelda, 'saves-link'), 'junction')
    await interrupted(zelda)
    const { importer } = setup()
    await importer.recover()
    expect(await fs.readFile(join(zelda, 'saves-link', 'slot1.bin'), 'utf8')).toBe('save')
    expect(await readJournalFile()).toEqual([])
  })

  it('once recorded, a failure after the move never reports the import as failed', async () => {
    const zelda = await rlZelda()
    const { importer, state, afterImport } = setup({
      readProfile: async () => {
        // The journal cannot be written any more (a folder where its file was).
        await fs.rm(journalFile(), { force: true })
        await file(join(journalFile(), 'x'), 'x')
        return null
      }
    })
    await importer.scan([zelda])
    const result = await importer.run([{ folder: zelda, recompId: ZELDA }])
    expect((await state.read()).installed[ZELDA]?.dir).toBe(zeldaTarget())
    expect(result.failed).toEqual([])
    expect(result.imported).toHaveLength(1)
    expect(afterImport).toHaveBeenCalledWith([ZELDA])
  })

  it('an install started in PlayOut during the checks stops the import before anything moves', async () => {
    const zelda = await rlZelda()
    await file(join(zelda, 'VERSION'), '1.2.2')
    let installing = false
    let importingSeen = false
    const { importer, state } = setup({
      busy: () => installing,
      releasesOf: async () => {
        importingSeen = importer.importing(ZELDA)
        installing = true
        return []
      }
    })
    await importer.scan([zelda])
    const result = await importer.run([{ folder: zelda, recompId: ZELDA }])
    expect(importingSeen).toBe(true)
    expect(importer.importing(ZELDA)).toBe(false)
    expect(result.imported).toEqual([])
    expect(result.failed[0]!.message).toMatch(/installing or running/)
    expect(await exists(join(zelda, 'saves', 'slot1.bin'))).toBe(true)
    expect((await state.read()).installed[ZELDA]).toBeUndefined()
  })

  it('refuses to move while the running programs cannot be listed, or one named like its program runs', async () => {
    const zelda = await rlZelda()
    let fail = true
    const procs: ImportProcess[] = []
    const { importer } = setup({
      processes: async () => {
        if (fail) throw new Error('access denied')
        return procs
      }
    })
    expect((await importer.scan([zelda])).items[0]!.blocked).toMatch(/could not check/)
    let result = await importer.run([{ folder: zelda, recompId: ZELDA }])
    expect(result.failed[0]!.message).toMatch(/could not check/)
    fail = false
    procs.push({ name: 'Zelda64Recompiled.exe', path: null })
    expect((await importer.scan([zelda])).items[0]!.blocked).toMatch(/is running/)
    result = await importer.run([{ folder: zelda, recompId: ZELDA }])
    expect(result.failed[0]!.message).toMatch(/is running/)
    expect(await exists(join(zelda, 'saves', 'slot1.bin'))).toBe(true)
  })

  it('never offers or moves a protected folder (the Emulation folder)', async () => {
    const docs = join(tmp, 'Documents')
    const emu = join(docs, 'Emulation')
    await file(join(emu, 'saves', 'memcard.ps2'), 'card')
    const q = join(tmp, 'Quiver Launcher')
    await file(join(q, 'QuiverLauncher.exe'))
    await file(
      join(q, 'apps.json'),
      JSON.stringify({ apps: [{ folderName: 'Emulation', repository: 'a/b' }] })
    )
    await file(join(q, 'settings.json'), JSON.stringify({ AppsPath: docs }))
    const { importer } = setup({ protectedDirs: async () => ({ inside: [emu], holds: [docs] }) })
    const scan = await importer.scan([q])
    expect(scan.items.map((i) => i.folder)).toEqual([emu])
    expect(scan.items[0]!.blocked).toMatch(/never moved/)
    const result = await importer.run([{ folder: emu, recompId: ZELDA }])
    expect(result.failed[0]!.message).toMatch(/never moved/)
    expect(await fs.readFile(join(emu, 'saves', 'memcard.ps2'), 'utf8')).toBe('card')
  })

  it('a file link that cannot be made again is reported, not a reason to put the app back', async () => {
    const zelda = await rlZelda()
    const link = join(zelda, 'last_run.log')
    try {
      await fs.symlink(join(zelda, 'saves', 'slot1.bin'), link, 'file')
    } catch {
      return // File links need Developer Mode or administrator rights on this PC.
    }
    const real = fs.symlink.bind(fs)
    const spy = vi
      .spyOn(fs, 'symlink')
      .mockImplementation(async (target, path, type) =>
        type === 'file' ? Promise.reject(new Error('EPERM: not allowed')) : real(target, path, type)
      )
    try {
      const { importer, state } = setup()
      await importer.scan([zelda])
      const result = await importer.run([{ folder: zelda, recompId: ZELDA }])
      expect(result.failed).toEqual([])
      expect(result.imported[0]).toMatchObject({ linksNotFixed: 1 })
      expect((await state.read()).installed[ZELDA]?.dir).toBe(zeldaTarget())
    } finally {
      spy.mockRestore()
    }
  })

  it('a recompilation installed with both launchers starts chosen on one row only', async () => {
    await quiverSkate()
    const lib = join(tmp, 'Recomp Library')
    await fs.mkdir(join(lib, '.backups'), { recursive: true })
    const rlSkate = join(lib, 'skate1recompiled')
    await file(join(rlSkate, 'skate1.exe'), 'game')
    await file(
      join(rlSkate, 'recomplauncher.json'),
      JSON.stringify({ repo: 'someone/Skate1Recompiled' })
    )
    const { importer } = setup()
    const scan = await importer.scan([join(tmp, 'Desktop', 'Quiver Launcher'), lib])
    const skates = scan.items.filter((i) => i.choices[0]?.id === SKATE)
    expect(skates).toHaveLength(2)
    // The one with a known version keeps it; the other starts at Skip and names the other folder.
    expect(skates.map((i) => [i.launcher, i.recompId])).toEqual([
      ['quiver', SKATE],
      ['recomplauncher', null]
    ])
    expect(skates[1]!.notes[0]).toMatch(/Also installed with Quiver Launcher/)
  })

  it('a multi-game repository picks the game the other launcher names; a bare folder shows its match', async () => {
    const MUA = 'github:x/mua#mua'
    const MUA2 = 'github:x/mua#mua2'
    // One project for both games: the same name, the games differ.
    const mua = [
      { ...entry(MUA, 'x/mua', 'Marvel Ultimate Alliance'), name: 'MUA Port' },
      { ...entry(MUA2, 'x/mua', 'Marvel Ultimate Alliance 2'), name: 'MUA Port' }
    ]
    const cat: RecompCatalog = {
      ...catalog,
      entries: new Map([...catalog.entries, ...mua.map((e) => [e.id, e] as const)]),
      byRepo: new Map([...catalog.byRepo, ['github:x/mua', [MUA2, MUA]]])
    }
    const q = join(tmp, 'Quiver Launcher')
    await file(join(q, 'QuiverLauncher.exe'))
    await file(
      join(q, 'apps.json'),
      JSON.stringify({
        apps: [
          {
            name: 'Marvel Ultimate Alliance',
            folderName: 'MarvelUltimateAlliance-MUAPort',
            repository: 'x/mua'
          }
        ]
      })
    )
    await file(join(q, 'apps', 'MarvelUltimateAlliance-MUAPort', 'mua.exe'))
    const zelda = await rlZelda()
    const { importer } = setup({ catalog: () => cat })
    const scan = await importer.scan([q, zelda])
    const row = scan.items.find((i) => i.launcher === 'quiver')!
    expect(row.recompId).toBe(MUA)
    expect(row.choices[0]!.id).toBe(MUA)
    // RecompLauncher's folder is only its app id: the row shows the recompilation it surely is.
    expect(scan.items.find((i) => i.folder === zelda)!.name).toBe('Zelda 64 Recompiled')
  })

  it('the catalog list says which recompilations are installed already', async () => {
    await createRecompState(root).update((m) => {
      m.installed[SKATE] = { id: SKATE, dir: join(root, 'x'), tag: 'v1' } as InstalledRecomp
    })
    const zelda = await rlZelda()
    const { importer } = setup()
    const scan = await importer.scan([zelda])
    expect(scan.catalog.find((c) => c.id === SKATE)).toMatchObject({ installed: true })
    expect(scan.catalog.find((c) => c.id === ZELDA)).toMatchObject({
      installed: false,
      targetTaken: false,
      target: zeldaTarget()
    })
  })
})
