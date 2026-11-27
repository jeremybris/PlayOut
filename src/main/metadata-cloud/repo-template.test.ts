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
    }
    expect(all).toEqual({
      generatedAt: '2026-11-16T12:00:00.000Z',
      relayUrl: 'https://relay.example.workers.dev',
      games: { 'steam-620': portal }
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
