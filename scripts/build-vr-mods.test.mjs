// Tests for scripts/build-vr-mods.mjs (run with `node --test "scripts/*.test.mjs"`).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
  buildCatalog,
  cleanEntry,
  extractReleases,
  OUTPUT,
  parseGithub,
  readExtras,
  withExtras
} from './build-vr-mods.mjs'

describe('parseGithub', () => {
  it('reads a repository link', () => {
    assert.deepEqual(parseGithub('https://github.com/mark-mon/edge-of-eternity-vr'), {
      owner: 'mark-mon',
      repo: 'edge-of-eternity-vr',
      tag: null
    })
  })

  it('reads www.github.com, a trailing .git, query strings and fragments', () => {
    assert.deepEqual(parseGithub('https://www.github.com/Owner/Repo.git'), {
      owner: 'Owner',
      repo: 'Repo',
      tag: null
    })
    assert.deepEqual(parseGithub('https://github.com/momotori01/ENSHROUDED-VR-MOD?v=2'), {
      owner: 'momotori01',
      repo: 'ENSHROUDED-VR-MOD',
      tag: null
    })
    assert.deepEqual(
      parseGithub('https://github.com/tig3rmast3r/OFXR-Bridge/releases#release-0.3.1-v681'),
      { owner: 'tig3rmast3r', repo: 'OFXR-Bridge', tag: null }
    )
  })

  it('gives no tag for /releases and /releases/latest', () => {
    assert.equal(parseGithub('https://github.com/a/b/releases').tag, null)
    assert.equal(parseGithub('https://github.com/a/b/releases/latest').tag, null)
  })

  it('reads the tag of /releases/tag/<tag> and /releases/download/<tag>/<file>', () => {
    assert.deepEqual(parseGithub('https://github.com/a/b/releases/tag/v0.9.0%2Bbeta'), {
      owner: 'a',
      repo: 'b',
      tag: 'v0.9.0+beta'
    })
    assert.equal(
      parseGithub('https://github.com/a/b/releases/download/installer-1.0.0-rc.4/Setup.exe').tag,
      'installer-1.0.0-rc.4'
    )
  })

  it('keeps a part with a malformed escape as written instead of throwing', () => {
    assert.deepEqual(parseGithub('https://github.com/someone/mod/releases/tag/v1.0-100%'), {
      owner: 'someone',
      repo: 'mod',
      tag: 'v1.0-100%'
    })
    assert.doesNotThrow(() => parseGithub('https://github.com/a%E0%A4%A/b'))
  })

  it('gives null for a user profile, another host or a non-URL', () => {
    assert.equal(parseGithub('https://github.com/King-EJ?tab=repositories'), null)
    assert.equal(parseGithub('https://gitlab.com/a/b'), null)
    assert.equal(parseGithub('https://www.nexusmods.com/game/mods/1'), null)
    assert.equal(parseGithub('not a url'), null)
  })
})

describe('extractReleases', () => {
  it('cuts the JSON array out of the page (brackets inside strings do not end it)', () => {
    const html = `<script>
    const releases = [{"title":"A ] tricky [ title","tags":["x"]},{"title":"B \\" quoted"}];
    const other = [1, 2];
    </script>`
    assert.deepEqual(extractReleases(html), [
      { title: 'A ] tricky [ title', tags: ['x'] },
      { title: 'B " quoted' }
    ])
  })

  it('refuses a page without the list or with a list that is not JSON', () => {
    assert.throws(() => extractReleases('<p>nothing</p>'), /no `const releases/)
    assert.throws(() => extractReleases('const releases = [{title: 1}];'), /not JSON/)
  })
})

describe('cleanEntry / buildCatalog', () => {
  const raw = (over) => ({
    date: '2026-10-29',
    title: 'Edge of Eternity VR',
    author: 'markmon',
    status: 'First build',
    group: 'debut',
    outside: false,
    accent: '#BAF56A',
    tags: ['PCVR', 'PCVR', ' gamepad '],
    summary: 'Summary',
    highlights: ['One'],
    source: 'https://github.com/mark-mon/edge-of-eternity-vr/releases/latest',
    evidence: 'https://discord.com/channels/1/2',
    evidenceLabel: 'Discord thread ↗',
    video: null,
    ...over
  })

  it('keeps the page link, parses GitHub and drops the evidence label', () => {
    const e = cleanEntry(raw())
    assert.equal(e.page, 'https://github.com/mark-mon/edge-of-eternity-vr/releases/latest')
    assert.deepEqual(e.github, { owner: 'mark-mon', repo: 'edge-of-eternity-vr', tag: null })
    assert.equal(e.thread, 'https://discord.com/channels/1/2')
    assert.deepEqual(e.tags, ['PCVR', 'gamepad'])
    assert.equal(e.accent, '#baf56a')
    assert.equal(e.kind, 'debut')
    assert.equal('evidenceLabel' in e, false)
  })

  it('keeps non-GitHub pages without a repository', () => {
    const e = cleanEntry(raw({ source: 'https://www.nexusmods.com/silenthilltownfall/mods/122' }))
    assert.equal(e.github, null)
    assert.equal(e.page, 'https://www.nexusmods.com/silenthilltownfall/mods/122')
  })

  it('gives a later entry of the same name a dated id and lists newest first', () => {
    const cat = buildCatalog([
      raw({ date: '2026-10-29', status: 'v2' }),
      raw({ date: '2026-10-01', status: 'v1' }),
      raw({ date: '2026-10-15', title: 'Other' })
    ])
    assert.deepEqual(
      cat.mods.map((m) => [m.id, m.status || m.title]),
      [
        ['edge-of-eternity-vr-2026-10-29', 'v2'],
        ['other', 'First build'],
        ['edge-of-eternity-vr', 'v1']
      ]
    )
    assert.equal(cat.updated, '2026-10-29')
  })
})

describe('resources/vr/vr-mods.json', () => {
  it('has unique ids and GitHub repositories for GitHub links', async () => {
    const cat = JSON.parse(await readFile(OUTPUT, 'utf8'))
    assert.ok(cat.mods.length > 100)
    assert.equal(new Set(cat.mods.map((m) => m.id)).size, cat.mods.length)
    for (const m of cat.mods) {
      if (m.github) assert.match(m.page, /^https:\/\/(www\.)?github\.com\//)
    }
  })
})

describe('hand-added VR mods (scripts/vr-mods-extra.json)', () => {
  it('are added unless the page already lists the same GitHub project', () => {
    const page = [{ title: 'A', source: 'https://github.com/Owner/Repo/releases/latest' }]
    const extras = [
      { title: 'A again', source: 'https://github.com/owner/repo' },
      { title: 'B', source: 'https://github.com/Other/Mod' }
    ]
    assert.deepEqual(
      withExtras(page, extras).map((r) => r.title),
      ['A', 'B']
    )
  })

  it('all parse as GitHub mods and reach the bundled catalog', async () => {
    const extras = await readExtras()
    assert.ok(extras.length >= 5)
    const catalog = JSON.parse(await readFile(OUTPUT, 'utf8'))
    for (const e of extras) {
      const entry = cleanEntry(e)
      assert.ok(entry.github, `${e.title}: not a GitHub link`)
      assert.ok(
        catalog.mods.some(
          (m) => m.github?.owner === entry.github.owner && m.github?.repo === entry.github.repo
        ),
        `${e.title}: not in ${OUTPUT}`
      )
    }
  })
})
