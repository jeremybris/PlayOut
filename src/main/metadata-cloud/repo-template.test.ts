// The metadata repository's own scripts (metadata-repo/scripts: the GitHub Actions run them) against temp folders,
// and that their schema accepts what PlayOut publishes and refuses what PlayOut refuses.
import { spawnSync } from 'child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unsafeMetadataFields } from '../../shared/metadata-cloud'
import type { MetadataEdit } from '../../shared/metadata-edit'
import { safeParseMetadataEdit } from '../metadata-edits/schema'

const SCRIPTS = resolve(__dirname, '../../../metadata-repo/scripts')

interface Problem {
  file: string
  error: string
}
interface Scripts {
  buildAll(root: string, now?: Date): { written: boolean; count: number; invalid: unknown[] }
  checkFiles(root: string, paths: string[], opts?: { suggestion?: boolean }): Problem[]
  validateGameFile(name: string, text: string): { record: unknown; errors: string[] }
}

async function load(): Promise<Scripts> {
  const url = (name: string): string => pathToFileURL(join(SCRIPTS, name)).href
  const [build, check, validate] = (await Promise.all([
    import(url('build-all.mjs')),
    import(url('check.mjs')),
    import(url('validate.mjs'))
  ])) as [Pick<Scripts, 'buildAll'>, Pick<Scripts, 'checkFiles'>, Pick<Scripts, 'validateGameFile'>]
  return { ...build, ...check, ...validate }
}

const record = (key: string, fields: MetadataEdit, title = 'A game'): string =>
  `${JSON.stringify({ key, title, fields, updatedAt: '2026-11-16T12:00:00.000Z' }, null, 2)}\n`

let root: string
let s: Scripts

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'playout-metarepo-'))
  await mkdir(join(root, 'games'))
  s = await load()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('metadata-repo scripts', () => {
  it('builds all.json from the valid games, leaves invalid ones out and rewrites only on change', async () => {
    const portal: MetadataEdit = {
      releaseDate: '2011-04-18',
      developers: ['Valve'],
      localPlayers: 2,
      controls: { controller: 'full', vr: 'none' },
      hltb: { main: 8.5, completionist: 22 },
      reviewScore: { score: 98, source: 'steam' }
    }
    await writeFile(join(root, 'games', 'steam-620.json'), record('steam-620', portal))
    await writeFile(join(root, 'games', 'steam-400.json'), record('steam-999', { genres: ['A'] }))
    await writeFile(
      join(root, 'games', 'snes-chrono.json'),
      record('snes-chrono', { genres: ['<b>x</b>'] })
    )
    await writeFile(
      join(root, 'config.json'),
      '{ "relayUrl": "https://relay.example.workers.dev" }\n'
    )

    const first = s.buildAll(root, new Date('2026-11-16T12:00:00Z'))
    expect(first).toMatchObject({ written: true, count: 1 })
    expect(first.invalid).toHaveLength(2)
    const all = JSON.parse(await readFile(join(root, 'all.json'), 'utf8')) as {
      generatedAt: string
      relayUrl: string
      games: Record<string, unknown>
      recomps: unknown[]
    }
    expect(all).toEqual({
      generatedAt: '2026-11-16T12:00:00.000Z',
      relayUrl: 'https://relay.example.workers.dev',
      games: { 'steam-620': portal },
      recomps: []
    })
    // What all.json carries is what PlayOut accepts.
    expect(safeParseMetadataEdit(all.games['steam-620'])).toEqual(portal)

    expect(s.buildAll(root, new Date('2026-11-17T00:00:00Z')).written).toBe(false)
  })

  it('validates what PlayOut would publish and refuses what PlayOut refuses', () => {
    const fine: MetadataEdit = {
      title: 'Portal 2',
      description: 'Line\nline',
      genres: [],
      localPlayers: 0
    }
    expect(safeParseMetadataEdit(fine)).not.toBeNull()
    expect(unsafeMetadataFields(fine)).toEqual([])
    expect(s.validateGameFile('steam-620.json', record('steam-620', fine)).errors).toEqual([])

    const html: MetadataEdit = { description: 'a <i>b</i>' }
    expect(unsafeMetadataFields(html)).toEqual(['description'])
    expect(s.validateGameFile('steam-620.json', record('steam-620', html)).errors).not.toEqual([])

    expect(
      s.validateGameFile('steam-620.json', record('steam-620', { localPlayers: 65 })).errors
    ).not.toEqual([])
    expect(
      s.validateGameFile('steam-620.json', record('steam-620', { releaseDate: '16/11/2026' }))
        .errors
    ).not.toEqual([])
    expect(s.validateGameFile('steam-abc.json', record('steam-abc', {})).errors).not.toEqual([])
  })

  it('accepts the controls touch and keyboard flags, and no other controls keys', () => {
    for (const controls of [
      { controller: 'none', vr: 'none', touch: true },
      { controller: 'full', vr: 'none', keyboard: true },
      { controller: 'full', vr: 'supported', keyboard: true }
    ] as const) {
      const edit: MetadataEdit = { controls: { ...controls } }
      expect(safeParseMetadataEdit(edit)).toEqual(edit)
      expect(s.validateGameFile('steam-620.json', record('steam-620', edit)).errors).toEqual([])
    }
    const odd = { controls: { controller: 'full', vr: 'none', mouse: true } }
    expect(
      s.validateGameFile('steam-620.json', record('steam-620', odd as MetadataEdit)).errors
    ).not.toEqual([])
    const notBool = { controls: { controller: 'full', vr: 'none', touch: 'yes' } }
    expect(
      s.validateGameFile('steam-620.json', record('steam-620', notBool as unknown as MetadataEdit))
        .errors
    ).not.toEqual([])
  })

  it('PlayOut, the relay and the repository accept the same release dates', async () => {
    // The relay is a package of its own (no import across): loaded by path, as the scripts are.
    const relay = (await import(
      pathToFileURL(resolve(__dirname, '../../../metadata-relay/src/validate.ts')).href
    )) as { validateFields(input: unknown): { ok: boolean } }
    const accepted = (releaseDate: string): Record<string, boolean> => ({
      app: safeParseMetadataEdit({ releaseDate }) !== null,
      relay: relay.validateFields({ releaseDate }).ok,
      repo:
        s.validateGameFile('steam-620.json', record('steam-620', { releaseDate })).errors.length ===
        0
    })
    const all = (ok: boolean): Record<string, boolean> => ({ app: ok, relay: ok, repo: ok })
    for (const date of ['', '2011', '2011-04', '2011-12', '2011-04-18', '2011-01-31', '1999-10-01'])
      expect(accepted(date), date).toEqual(all(true))
    for (const date of [
      '2011-13',
      '2011-00',
      '2011-13-45',
      '2011-04-00',
      '2011-04-32',
      '2011-4-18',
      '11-04-18',
      '2011-04-18T00:00',
      '16/11/2026',
      'April 2011'
    ])
      expect(accepted(date), date).toEqual(all(false))
  })

  it('checks a pull request: suggestions may only change games/<key>.json', async () => {
    await writeFile(
      join(root, 'games', 'steam-620.json'),
      record('steam-620', { genres: ['Puzzle'] })
    )
    await writeFile(join(root, 'all.json'), '{}')
    expect(s.checkFiles(root, ['games/steam-620.json'], { suggestion: true })).toEqual([])
    expect(s.checkFiles(root, ['all.json'], { suggestion: false })).toHaveLength(1)
    expect(s.checkFiles(root, ['scripts/build-all.mjs'], { suggestion: true })).toHaveLength(1)
    // A deleted file is fine for the owner's own pull requests.
    expect(s.checkFiles(root, ['games/steam-1.json'])).toEqual([])
  })

  it('reads the pull request files from --root (the check workflow)', async () => {
    await writeFile(
      join(root, 'games', 'steam-620.json'),
      record('steam-620', { localPlayers: 99 })
    )
    const run = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'check.mjs'), '--root', root, 'games/steam-620.json'],
      { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    )
    expect(run.status).toBe(1)
    expect(run.stdout).toMatch(/::error file=games\/steam-620\.json::.*above 64/)
  })
})

describe('metadata-repo scripts: recompilations', () => {
  interface RecompScripts {
    buildAll(
      root: string,
      now?: Date
    ): { written: boolean; recomps: number; invalid: { file: string }[] }
    checkFiles(
      root: string,
      paths: string[],
      opts?: { suggestion?: boolean; recompSuggestion?: boolean; headRef?: string }
    ): Problem[]
    validateRecompFile(name: string, text: string): { record: unknown; errors: string[] }
    suggestionKind(opts: {
      headRef?: string
      suggestion?: boolean
      recompSuggestion?: boolean
    }): string | null
  }
  const url = (name: string): string => pathToFileURL(join(SCRIPTS, name)).href
  async function loadRecomp(): Promise<RecompScripts> {
    const [build, check, validate] = await Promise.all([
      import(url('build-all.mjs')),
      import(url('check.mjs')),
      import(url('validate.mjs'))
    ])
    return { ...build, ...check, ...validate } as RecompScripts
  }
  const recomp = (patch: Record<string, unknown> = {}): string =>
    `${JSON.stringify(
      {
        id: 'github:zeldaret/mm',
        repo: 'ZeldaRET/mm',
        repoUrl: 'https://github.com/ZeldaRET/mm',
        game: "The Legend of Zelda: Majora's Mask",
        systemId: 'n64',
        blurb: 'A native PC port.',
        addedAt: '2026-11-27T12:00:00.000Z',
        updatedAt: '2026-11-27T12:00:00.000Z',
        ...patch
      },
      null,
      2
    )}\n`

  it('validates a recompilation file: its id, page and file name must name its repository', async () => {
    const r = await loadRecomp()
    expect(r.validateRecompFile('zeldaret__mm.json', recomp()).errors).toEqual([])
    const refused: [string, string][] = [
      ['zeldaret__mm.json', recomp({ id: 'github:ZeldaRET/mm' })],
      ['zeldaret__mm.json', recomp({ id: 'github:other/mm' })],
      ['zeldaret__mm.json', recomp({ repoUrl: 'https://evil.example/ZeldaRET/mm' })],
      ['other__mm.json', recomp()],
      ['zeldaret__mm.json', recomp({ game: '<script>x</script>' })],
      ['zeldaret__mm.json', recomp({ game: 'two\nlines' })],
      ['zeldaret__mm.json', recomp({ game: '' })],
      ['zeldaret__mm.json', recomp({ systemId: 'N64!' })],
      ['zeldaret__mm.json', recomp({ blurb: 'x'.repeat(501) })],
      ['zeldaret__mm.json', recomp({ extra: 1 })],
      [
        'a__...json',
        recomp({ id: 'github:a/..', repo: 'a/..', repoUrl: 'https://github.com/a/..' })
      ],
      ['zeldaret__mm.json', '{ not json']
    ]
    for (const [name, text] of refused)
      expect(r.validateRecompFile(name, text).errors, `${name} ${text}`).not.toEqual([])
  })

  it('builds all.json recomps (sorted, valid ones only) beside the games, which older PlayOuts ignore', async () => {
    const r = await loadRecomp()
    await mkdir(join(root, 'recomps'))
    await writeFile(join(root, 'recomps', 'zeldaret__mm.json'), recomp())
    await writeFile(
      join(root, 'recomps', 'a__b.json'),
      recomp({ id: 'github:a/b', repo: 'a/b', repoUrl: 'https://github.com/a/b', blurb: undefined })
    )
    await writeFile(join(root, 'recomps', 'bad__one.json'), recomp())
    const result = r.buildAll(root, new Date('2026-11-27T13:00:00Z'))
    expect(result.written).toBe(true)
    expect(result.recomps).toBe(2)
    expect(result.invalid.map((i) => i.file)).toEqual(['recomps/bad__one.json'])
    const all = JSON.parse(await readFile(join(root, 'all.json'), 'utf8')) as {
      recomps: Record<string, unknown>[]
    }
    expect(all.recomps).toEqual([
      {
        id: 'github:a/b',
        repo: 'a/b',
        repoUrl: 'https://github.com/a/b',
        game: "The Legend of Zelda: Majora's Mask",
        systemId: 'n64',
        addedAt: '2026-11-27T12:00:00.000Z'
      },
      {
        id: 'github:zeldaret/mm',
        repo: 'ZeldaRET/mm',
        repoUrl: 'https://github.com/ZeldaRET/mm',
        game: "The Legend of Zelda: Majora's Mask",
        systemId: 'n64',
        blurb: 'A native PC port.',
        addedAt: '2026-11-27T12:00:00.000Z'
      }
    ])
    // Unchanged: not rewritten. A recompilation file changed: rewritten.
    expect(r.buildAll(root).written).toBe(false)
    await writeFile(join(root, 'recomps', 'zeldaret__mm.json'), recomp({ game: 'Majora' }))
    expect(r.buildAll(root).written).toBe(true)
  })

  it('passes only records PlayOut keeps: one console list, no tabs or control characters', async () => {
    const r = await loadRecomp()
    const { parseCloudRecomp } = await import('./recomps')
    const { RECOMP_CONSOLE_IDS } = await import('../recomp/consoles')
    const schema = JSON.parse(
      await readFile(join(SCRIPTS, '..', 'recomp-schema.json'), 'utf8')
    ) as { properties: { systemId: { enum: string[] } } }
    expect([...schema.properties.systemId.enum].sort()).toEqual([...RECOMP_CONSOLE_IDS].sort())
    const row = (text: string): unknown => {
      const rest = JSON.parse(text) as Record<string, unknown>
      delete rest.updatedAt
      return rest
    }
    for (const patch of [
      { systemId: 'emulators' },
      { systemId: 'n46' },
      { game: 'Zel\tda' },
      { blurb: 'a\tb' },
      { game: 'Zel\u0001da' }
    ]) {
      const text = recomp(patch)
      expect(
        r.validateRecompFile('zeldaret__mm.json', text).errors,
        JSON.stringify(patch)
      ).not.toEqual([])
      expect(parseCloudRecomp(row(text)), JSON.stringify(patch)).toBeNull()
    }
    // Every console PlayOut offers passes the check and is kept.
    for (const systemId of RECOMP_CONSOLE_IDS) {
      const text = recomp({ systemId })
      expect(r.validateRecompFile('zeldaret__mm.json', text).errors, systemId).toEqual([])
      expect(parseCloudRecomp(row(text)), systemId).not.toBeNull()
    }
  })

  it('reads every row PlayOut reads (the app parses all.json recomps with the same rules)', async () => {
    const r = await loadRecomp()
    const { parseCloudRecomps } = await import('./recomps')
    await mkdir(join(root, 'recomps'))
    await writeFile(join(root, 'recomps', 'zeldaret__mm.json'), recomp())
    r.buildAll(root)
    const all = JSON.parse(await readFile(join(root, 'all.json'), 'utf8')) as { recomps: unknown[] }
    expect(parseCloudRecomps(all.recomps)).toHaveLength(1)
  })

  it('checks pull requests: a recompilation suggestion may only change recomps/, a game suggestion only games/', async () => {
    const r = await loadRecomp()
    await mkdir(join(root, 'recomps'))
    await writeFile(join(root, 'recomps', 'zeldaret__mm.json'), recomp())
    await writeFile(join(root, 'games', 'steam-620.json'), record('steam-620', { genres: ['A'] }))
    const recompHead = { headRef: 'suggest/recomp/zeldaret__mm-abc12345' }
    expect(r.checkFiles(root, ['recomps/zeldaret__mm.json'], recompHead)).toEqual([])
    expect(r.checkFiles(root, ['games/steam-620.json'], recompHead)).toHaveLength(1)
    expect(r.checkFiles(root, ['scripts/check.mjs'], recompHead)).toHaveLength(1)
    // The head branch decides even without a label (the relay's label may have failed to go on).
    const gameHead = { headRef: 'suggest/steam-620-abc12345' }
    expect(r.checkFiles(root, ['games/steam-620.json'], gameHead)).toEqual([])
    expect(r.checkFiles(root, ['recomps/zeldaret__mm.json'], gameHead)).toHaveLength(1)
    expect(r.checkFiles(root, ['recomps/zeldaret__mm.json'], { recompSuggestion: true })).toEqual(
      []
    )
    // The owner's own pull request: anything, each file validated.
    expect(r.checkFiles(root, ['recomps/zeldaret__mm.json', 'games/steam-620.json'])).toEqual([])
    await writeFile(join(root, 'recomps', 'zeldaret__mm.json'), recomp({ systemId: '' }))
    expect(r.checkFiles(root, ['recomps/zeldaret__mm.json'])).not.toEqual([])
    expect(r.suggestionKind({ headRef: 'suggest/recomp/a__b-1', suggestion: true })).toBe('recomp')
    expect(r.suggestionKind({ headRef: 'feature/x' })).toBeNull()
  })

  it('takes the head branch from CHECK_HEAD_REF in the check workflow', () => {
    const run = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'check.mjs'), '--root', root, 'games/steam-620.json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          CHECK_HEAD_REF: 'suggest/recomp/zeldaret__mm-abc12345'
        }
      }
    )
    expect(run.status).toBe(1)
    expect(run.stdout).toMatch(/recompilation suggestion may only change recomps/)
  })
})
