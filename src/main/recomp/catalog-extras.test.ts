// The recompilations added in PlayOut (the browser's Add, PlayOut's list in the metadata cloud) and the catalog:
// reading a pasted GitHub link, laying the adds into the catalog, and the consoles an add may name.
import { describe, expect, it } from 'vitest'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import type { AddedRecomp, CloudRecomp, RecompEntry } from '../../shared/recomp'
import {
  buildCatalog,
  entryTitleKey,
  parseGithubUrl,
  withExtras,
  type RecompCatalog
} from './catalog'
import { RECOMP_CONSOLE_IDS, isRecompConsole } from './consoles'

describe('parseGithubUrl', () => {
  it('reads every form a repository is pasted in', () => {
    const zelda = { owner: 'Zelda64Recomp', repo: 'Zelda64Recomp' }
    for (const text of [
      'Zelda64Recomp/Zelda64Recomp',
      'github.com/Zelda64Recomp/Zelda64Recomp',
      'www.github.com/Zelda64Recomp/Zelda64Recomp',
      'https://github.com/Zelda64Recomp/Zelda64Recomp',
      'http://github.com/Zelda64Recomp/Zelda64Recomp/',
      'https://www.github.com/Zelda64Recomp/Zelda64Recomp',
      '  https://github.com/Zelda64Recomp/Zelda64Recomp  ',
      'https://github.com/Zelda64Recomp/Zelda64Recomp.git',
      'https://github.com/Zelda64Recomp/Zelda64Recomp/releases/latest',
      'https://github.com/Zelda64Recomp/Zelda64Recomp/tree/dev/src',
      'https://github.com/Zelda64Recomp/Zelda64Recomp/blob/main/README.md#install',
      'https://github.com/Zelda64Recomp/Zelda64Recomp?tab=readme-ov-file',
      'https://github.com/Zelda64Recomp/Zelda64Recomp#readme',
      'git@github.com:Zelda64Recomp/Zelda64Recomp.git'
    ])
      expect(parseGithubUrl(text), text).toEqual(zelda)
    expect(parseGithubUrl('a/b.c_d-e')).toEqual({ owner: 'a', repo: 'b.c_d-e' })
  })

  it('refuses another host as not GitHub, and anything unreadable', () => {
    for (const text of [
      'https://gitlab.com/a/b',
      'codeberg.org/a/b',
      'https://github.io/a/b',
      'git@gitlab.com:a/b.git'
    ])
      expect(parseGithubUrl(text), text).toEqual({ error: 'notGithub' })
    for (const text of [
      '',
      '   ',
      'zelda',
      'https://github.com/onlyowner',
      'https://github.com/a/..',
      'https://github.com/a/.',
      'https://github.com/-bad/b',
      `https://github.com/${'a'.repeat(40)}/b`,
      'ftp://github.com/a/b',
      'https://user:pass@github.com/a/b',
      'https://github.com:8443/a/b',
      'a b/c',
      'https://github.com/a/b%2F..',
      'x'.repeat(3000)
    ])
      expect(parseGithubUrl(text), text).toEqual({ error: 'badUrl' })
  })
})

const ZELDA = 'github:zelda64recomp/zelda64recomp'

/** A loaded catalog with one recompilation of Majora's Mask (the shape buildCatalog makes). */
const base = (): RecompCatalog => {
  const key = entryTitleKey('n64', "The Legend of Zelda: Majora's Mask")
  const zelda: RecompEntry = {
    ...withExtras(
      buildCatalog({ fetchedAt: { 'decomp-buddy': null, recomplauncher: null }, offline: [] }),
      {
        cloud: [],
        user: [
          {
            id: ZELDA,
            repo: 'Zelda64Recomp/Zelda64Recomp',
            game: "The Legend of Zelda: Majora's Mask",
            systemId: 'n64',
            addedAt: '2026-01-01T00:00:00.000Z',
            state: 'local'
          }
        ]
      }
    ).entries.get(ZELDA)!,
    name: 'Zelda 64: Recompiled',
    sources: ['decomp-buddy', 'recomplauncher']
  }
  return {
    entries: new Map([[ZELDA, zelda]]),
    titles: new Map([
      [
        key,
        {
          key,
          game: "The Legend of Zelda: Majora's Mask",
          systemId: 'n64',
          console: 'Nintendo 64',
          entries: [ZELDA]
        }
      ]
    ]),
    byRepo: new Map([[ZELDA, [ZELDA]]]),
    fetchedAt: { 'decomp-buddy': null, recomplauncher: '2026-11-27T00:00:00.000Z' },
    offline: []
  }
}

const added = (over: Partial<AddedRecomp> = {}): AddedRecomp => ({
  id: 'github:someone/mmport',
  repo: 'someone/MMPort',
  game: "The Legend of Zelda: Majora's Mask",
  systemId: 'n64',
  blurb: 'Another port.',
  stars: 12,
  addedAt: '2026-11-27T00:00:00.000Z',
  state: 'queued',
  ...over
})

const cloud = (over: Partial<CloudRecomp> = {}): CloudRecomp => ({
  id: 'github:other/sonicport',
  repo: 'other/SonicPort',
  repoUrl: 'https://github.com/other/SonicPort',
  game: 'Sonic the Hedgehog',
  systemId: 'genesis',
  blurb: '',
  addedAt: '2026-11-01T00:00:00.000Z',
  ...over
})

describe('withExtras', () => {
  it('leaves the catalog as it is without adds', () => {
    const c = base()
    expect(withExtras(c, { cloud: [], user: [] })).toBe(c)
  })

  it("joins an add to its game's title, or makes a title of its own; the catalog is not changed", () => {
    const c = base()
    const zeldaKey = entryTitleKey('n64', "The Legend of Zelda: Majora's Mask")
    const before = c.titles.get(zeldaKey)!.entries.slice()
    const merged = withExtras(c, { cloud: [cloud()], user: [added()] })
    expect(merged.titles.get(zeldaKey)!.entries).toEqual([...before, 'github:someone/mmport'])
    const sonicKey = entryTitleKey('genesis', 'Sonic the Hedgehog')
    expect(merged.titles.get(sonicKey)).toEqual({
      key: sonicKey,
      game: 'Sonic the Hedgehog',
      systemId: 'genesis',
      console: 'Genesis / Mega Drive',
      entries: ['github:other/sonicport']
    })
    // The base catalog is untouched (its size tells whether the catalogs were loaded).
    expect(c.titles.get(zeldaKey)!.entries).toEqual(before)
    expect(c.entries.has('github:someone/mmport')).toBe(false)
    expect(merged.byRepo.get('github:someone/mmport')).toEqual(['github:someone/mmport'])
    const mine = merged.entries.get('github:someone/mmport') as RecompEntry
    expect(mine).toMatchObject({
      name: 'MMPort',
      author: 'someone',
      repo: 'someone/MMPort',
      repoUrl: 'https://github.com/someone/MMPort',
      console: 'Nintendo 64',
      sources: ['user'],
      scannedSha256: null,
      recommended: false,
      coverUrl: null,
      stars: 12
    })
    expect(merged.entries.get('github:other/sonicport')!.sources).toEqual(['playout'])
  })

  it("lets the catalog win by repository, and PlayOut's list win over this PC's add", () => {
    const c = base()
    const merged = withExtras(c, {
      cloud: [cloud({ id: 'github:a/b', repo: 'a/b', repoUrl: 'https://github.com/a/b' })],
      user: [
        added({ id: 'github:zelda64recomp/zelda64recomp', repo: 'Zelda64Recomp/Zelda64Recomp' }),
        added({ id: 'github:a/b', repo: 'A/B' })
      ]
    })
    expect(merged.entries.get('github:zelda64recomp/zelda64recomp')!.sources).not.toContain('user')
    expect(merged.entries.get('github:a/b')!.sources).toEqual(['playout'])
    expect(merged.entries.size).toBe(c.entries.size + 1)
  })

  it('marks an archived add with the warning tag', () => {
    const merged = withExtras(base(), { cloud: [], user: [added({ archived: true })] })
    expect(merged.entries.get('github:someone/mmport')!.tags.map((t) => t.kind)).toEqual([
      'warning'
    ])
  })
})

describe('the consoles an add may name', () => {
  it("are all systems the relay takes (resources/systems plus 'other')", async () => {
    const relay = (await import(
      pathToFileURL(resolve(__dirname, '../../../metadata-relay/src/platforms.ts')).href
    )) as { DB_PLATFORMS: ReadonlySet<string> }
    for (const id of RECOMP_CONSOLE_IDS)
      expect(id === 'other' || relay.DB_PLATFORMS.has(id), id).toBe(true)
    expect(RECOMP_CONSOLE_IDS.at(-1)).toBe('other')
    expect(isRecompConsole('n64')).toBe(true)
    expect(isRecompConsole('nope')).toBe(false)
    expect(isRecompConsole(undefined)).toBe(false)
  })
})
