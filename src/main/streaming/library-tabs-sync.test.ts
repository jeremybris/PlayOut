import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { LibraryTabDef, Settings } from '../../shared/types'
import type { Logger } from '../logger'
import {
  createLibraryTabsSync,
  MAX_TABS_DOC_BYTES,
  NEVER_EDITED,
  parseTabsDoc,
  pickTabsDoc,
  sameTabs,
  syncedTabs,
  type LibraryTabsDoc,
  type LibraryTabsSync
} from './library-tabs-sync'

/** The Library tabs kept the same on paired PCs: the document, the newest-wins rule, and a PC's side of it. */

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function tab(id: string, over: Partial<LibraryTabDef> = {}): LibraryTabDef {
  return {
    id,
    filters: {
      platforms: [],
      stores: [],
      genres: [],
      eras: [],
      tags: [],
      sizes: [],
      hltb: [],
      controls: [],
      players: [],
      online: [],
      hidden: false,
      favorites: false,
      coop: false,
      recomp: false
    },
    sort: 'title-asc',
    sortReversed: false,
    playableFirst: true,
    ...over
  }
}

const withPlatforms = (id: string, platforms: string[]): LibraryTabDef => {
  const t = tab(id)
  t.filters.platforms = platforms
  return t
}

function doc(tabs: LibraryTabDef[], updatedAt: string, by = 'pc-a'): LibraryTabsDoc {
  return { v: 1, tabs, updatedAt, by }
}

const NOW = Date.parse('2026-11-17T12:00:00.000Z')
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString()

describe('syncedTabs / sameTabs', () => {
  it('drops malformed and repeated tabs, removes the search text, keeps unknown filter ids', () => {
    const tabs = syncedTabs([
      { ...withPlatforms('t1', ['only-on-the-other-pc', 'ps2']), query: 'zelda' },
      { id: 't2', bogus: true },
      tab('t1'),
      tab('t3')
    ])
    expect(tabs?.map((t) => t.id)).toEqual(['t1', 't3'])
    expect(tabs?.[0]?.filters.platforms).toEqual(['only-on-the-other-pc', 'ps2'])
    expect(tabs?.[0]).not.toHaveProperty('query')
  })

  it('migrates tabs as settings.json does (the removed Playable First sort)', () => {
    const old = { ...tab('t1'), sort: 'playable', sortReversed: true } as unknown
    expect(syncedTabs([old])?.[0]).toMatchObject({
      sort: 'recent',
      sortReversed: false,
      playableFirst: true
    })
  })

  it('treats the same tabs with different search text, or older fields left out, as the same', () => {
    const legacy = tab('t1') as unknown as Record<string, unknown>
    delete legacy.playableFirst
    expect(sameTabs([{ ...tab('t1'), query: 'a' }], [legacy])).toBe(true)
    expect(sameTabs([tab('t1')], [tab('t1', { sort: 'recent' })])).toBe(false)
    expect(sameTabs([tab('t1'), tab('t2')], [tab('t2'), tab('t1')])).toBe(false)
  })

  it('sends a tab without a developer / publisher filter as an older PlayOut has it; one with them keeps them', () => {
    // Empty lists (a renderer that wrote them) are left out: the tab is byte-for-byte a 0.9.41 tab.
    const empty = tab('t1')
    empty.filters = { ...empty.filters, developers: [], publishers: [] }
    const [sent] = syncedTabs([empty])!
    expect(sent!.filters).not.toHaveProperty('developers')
    expect(sent!.filters).not.toHaveProperty('publishers')
    expect(JSON.stringify(sent)).toBe(JSON.stringify(tab('t1')))
    expect(sameTabs([empty], [tab('t1')])).toBe(true)
    // With names: kept as they are.
    const named = tab('t2')
    named.filters = { ...named.filters, developers: ['Atlus'], publishers: ['Sega'] }
    const [kept] = syncedTabs([named])!
    expect(kept!.filters).toMatchObject({ developers: ['Atlus'], publishers: ['Sega'] })
    // A copy from an older PlayOut with the single developer name is read as a list of one.
    const old = tab('t3')
    ;(old.filters as unknown as Record<string, unknown>).developer = 'Atlus'
    expect(syncedTabs([old])![0]!.filters).toMatchObject({ developers: ['Atlus'] })
    expect(syncedTabs([old])![0]!.filters).not.toHaveProperty('developer')
  })
})

describe('parseTabsDoc', () => {
  it('takes a good copy and puts its time on this clock', () => {
    const parsed = parseTabsDoc(doc([tab('t1')], at(0), 'pc-b'), NOW, 60_000)
    expect(parsed).toEqual(doc([tab('t1')], at(-1), 'pc-b'))
  })

  it('keeps a never-edited time as it is', () => {
    expect(parseTabsDoc(doc([], NEVER_EDITED), NOW, 60_000)?.updatedAt).toBe(NEVER_EDITED)
  })

  it.each([
    ['not an object', 'x'],
    ['another version', { ...doc([], at(0)), v: 2 }],
    ['no list', { ...doc([], at(0)), tabs: 'x' }],
    ['a bad time', doc([], 'yesterday')],
    ['a bad id', doc([], at(0), 'a b/c')],
    ['far in the future', doc([], at(60 * 25))]
  ])('refuses %s', (_name, raw) => {
    expect(parseTabsDoc(raw, NOW)).toBeNull()
  })

  it("refuses a whole copy with a tab this PC cannot read (a newer PlayOut's filter or sort)", () => {
    const newFilter = { ...tab('t2'), filters: { ...tab('t2').filters, newThing: [] } }
    expect(parseTabsDoc(doc([tab('t1'), newFilter as LibraryTabDef], at(0)), NOW)).toBeNull()
    const newSort = { ...tab('t2'), sort: 'some-new-sort' } as unknown as LibraryTabDef
    expect(parseTabsDoc(doc([newSort], at(0)), NOW)).toBeNull()
    expect(parseTabsDoc(doc([{ id: 5 } as unknown as LibraryTabDef], at(0)), NOW)).toBeNull()
    // Repeated ids are only folded, not a reason to refuse.
    expect(parseTabsDoc(doc([tab('t1'), tab('t1')], at(0)), NOW)?.tabs).toEqual([tab('t1')])
  })

  it('refuses a copy larger than the cap', () => {
    const big = Array.from({ length: 40 }, (_, i) =>
      withPlatforms(
        `t${i}`,
        Array.from({ length: 400 }, (_, j) => `platform-${j}`.padEnd(100, 'x'))
      )
    )
    expect(JSON.stringify(doc(big, at(0))).length).toBeGreaterThan(MAX_TABS_DOC_BYTES)
    expect(parseTabsDoc(doc(big, at(0)), NOW)).toBeNull()
  })
})

describe('pickTabsDoc', () => {
  const a = [tab('t1')]
  const b = [tab('t1', { sort: 'recent' })]

  it('takes the newer copy, both ways', () => {
    expect(pickTabsDoc(doc(a, at(0)), doc(b, at(1)), false)).toBe('theirs')
    expect(pickTabsDoc(doc(a, at(1)), doc(b, at(0)), true)).toBe('mine')
    expect(pickTabsDoc(doc(a, at(0)), doc(b, at(1)), true)).toBe('theirs')
  })

  it("gives a tie to the host's copy", () => {
    expect(pickTabsDoc(doc(a, at(0)), doc(b, at(0)), true)).toBe('theirs')
    expect(pickTabsDoc(doc(a, at(0)), doc(b, at(0)), false)).toBe('mine')
    expect(pickTabsDoc(doc(a, NEVER_EDITED), doc(b, NEVER_EDITED), true)).toBe('theirs')
    // Not when this PC's copy was already taken from another PC (a client of two hosts).
    expect(pickTabsDoc(doc(a, NEVER_EDITED), doc(b, NEVER_EDITED), true, false)).toBe('mine')
  })

  it('never picks a copy without tabs, and any copy with tabs beats an empty one', () => {
    expect(pickTabsDoc(doc(a, at(0)), doc([], at(5)), true)).toBe('mine')
    expect(pickTabsDoc(doc(a, NEVER_EDITED), doc([], NEVER_EDITED), true)).toBe('mine')
    expect(pickTabsDoc(doc([], at(5)), doc(a, NEVER_EDITED), false)).toBe('theirs')
  })

  it('changes nothing for the same tabs', () => {
    expect(pickTabsDoc(doc(a, at(0)), doc(a, at(5)), true)).toBe('same')
  })
})

// ---- a PC's side --------------------------------------------------------------------------------------------------

const dirs: string[] = []
const syncs: LibraryTabsSync[] = []
afterEach(async () => {
  for (const s of syncs.splice(0)) {
    s.dispose()
    await s.flush()
  }
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

interface Pc {
  sync: LibraryTabsSync
  settings: Settings
  /** The user changes the tabs (what the renderer's settings write does). */
  edit(tabs: LibraryTabDef[]): void
  applied: LibraryTabDef[][]
  file: string
  clock: { now: number }
}

async function pc(
  id: string,
  tabs: LibraryTabDef[] | null,
  options: { dir?: string; clock?: { now: number } } = {}
): Promise<Pc> {
  const dir = options.dir ?? (await fs.mkdtemp(join(tmpdir(), 'playout-tabs-')))
  if (!options.dir) dirs.push(dir)
  const settings = defaultSettings()
  settings.ui.libraryTabs = tabs
  const listeners = new Set<(s: Settings) => void>()
  const set = (next: LibraryTabDef[]): void => {
    settings.ui.libraryTabs = next
    for (const l of listeners) l(settings)
  }
  const applied: LibraryTabDef[][] = []
  const clock = options.clock ?? { now: NOW }
  const file = join(dir, 'library-tabs-sync.json')
  const sync = createLibraryTabsSync({
    file,
    settings: {
      get: () => settings,
      onChange: (l) => {
        listeners.add(l)
        return () => void listeners.delete(l)
      }
    },
    // What main/index.ts does: settings.update, whose change listeners run at once.
    apply: (next) => {
      applied.push(next)
      set(next)
    },
    deviceId: () => id,
    log: quiet,
    now: () => clock.now
  })
  syncs.push(sync)
  await sync.load()
  return { sync, settings, edit: set, applied, file, clock }
}

/** One client↔host exchange as the service runs it: the client's copy goes up, the host's answer comes back. */
function exchange(client: Pc, host: Pc, name = 'Client'): void {
  host.sync.offer(client.sync.doc(), { name, isHost: false })
  client.sync.offer(host.sync.doc(), { name: 'Host', isHost: true })
}

describe('createLibraryTabsSync', () => {
  it('starts never edited, from the current tabs, and writes its file', async () => {
    const a = await pc('pc-a', [tab('t1')])
    expect(a.sync.doc()).toEqual(doc([tab('t1')], NEVER_EDITED, 'pc-a'))
    await a.sync.flush()
    expect(JSON.parse(await fs.readFile(a.file, 'utf8'))).toMatchObject({
      updatedAt: NEVER_EDITED
    })
  })

  it("a user's change stamps it; search text alone does not", async () => {
    const a = await pc('pc-a', [tab('t1')])
    a.clock.now = NOW + 1000
    a.edit([tab('t1'), tab('t2')])
    expect(a.sync.doc()).toMatchObject({ updatedAt: new Date(NOW + 1000).toISOString() })
    a.clock.now = NOW + 5000
    a.edit([{ ...tab('t1'), query: 'mario' }, tab('t2')])
    expect(a.sync.doc()?.updatedAt).toBe(new Date(NOW + 1000).toISOString())
  })

  it("the renderer's first tabs (none before) are adopted without a stamp", async () => {
    const a = await pc('pc-a', null)
    a.edit([tab('t1'), tab('t2')])
    expect(a.sync.doc()).toMatchObject({ updatedAt: NEVER_EDITED })
    expect(a.sync.doc()?.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('a migration rewrite (the same tabs once normalized) is not a change', async () => {
    const legacy = { ...tab('t1'), sort: 'playable' } as unknown as LibraryTabDef
    const a = await pc('pc-a', [legacy])
    a.edit([tab('t1', { sort: 'recent', playableFirst: true })])
    expect(a.sync.doc()?.updatedAt).toBe(NEVER_EDITED)
  })

  it('keeps its stamp across a restart', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'playout-tabs-'))
    dirs.push(dir)
    const a = await pc('pc-a', [tab('t1')], { dir })
    a.edit([tab('t2')])
    const stamp = a.sync.doc()!.updatedAt
    await a.sync.flush()
    const again = await pc('pc-a', [tab('t2')], { dir })
    expect(again.sync.doc()?.updatedAt).toBe(stamp)
  })

  it("takes a newer copy, keeps this PC's search text, and does not restamp it", async () => {
    const a = await pc('pc-a', [{ ...tab('t1'), query: 'zelda' }])
    let changes = 0
    a.sync.onLocalChange(() => changes++)
    const theirs = doc([tab('t2'), tab('t1', { sort: 'recent' })], at(1), 'pc-b')
    expect(a.sync.offer(theirs, { name: 'Office', isHost: false })).toBe(true)
    expect(a.settings.ui.libraryTabs).toEqual([
      tab('t2'),
      { ...tab('t1', { sort: 'recent' }), query: 'zelda' }
    ])
    expect(a.sync.doc()).toEqual(theirs)
    expect(changes).toBe(0)
  })

  it("never sends a tab's Filters > Custom picks (this PC's own filters), and keeps them when taking another copy", async () => {
    const custom = (
      id: string,
      ids: string[],
      over: Partial<LibraryTabDef> = {}
    ): LibraryTabDef => {
      const t = tab(id, over)
      t.filters = { ...t.filters, custom: ids }
      return t
    }
    const a = await pc('pc-a', [custom('t1', ['cf1'])])
    // Sent without it: another PC (an older PlayOut too, whose tab schema is strict) reads the tab as it is.
    expect(a.sync.doc()!.tabs[0]!.filters).not.toHaveProperty('custom')
    expect(parseTabsDoc(a.sync.doc(), NOW)).not.toBeNull()
    // Picking or unpicking a custom filter is not a change to sync.
    a.clock.now = NOW + 1000
    a.edit([custom('t1', ['cf1', 'cf2'])])
    expect(a.sync.doc()?.updatedAt).toBe(NEVER_EDITED)
    // A copy from a PC that still sends them (or a newer tab) never brings another PC's filter ids here.
    const theirs = doc(
      [custom('t1', ['cf-other'], { sort: 'recent' }), custom('t2', ['cf-x'])],
      at(1),
      'pc-b'
    )
    expect(a.sync.offer(theirs, { name: 'Office', isHost: false })).toBe(true)
    expect(a.settings.ui.libraryTabs).toEqual([
      custom('t1', ['cf1', 'cf2'], { sort: 'recent' }),
      tab('t2')
    ])
  })

  it('ignores an older copy and a malformed one', async () => {
    const a = await pc('pc-a', [tab('t1')])
    a.clock.now = NOW + 120_000
    a.edit([tab('t1', { sort: 'size' })])
    expect(a.sync.offer(doc([tab('t9')], at(1), 'pc-b'), { name: 'B', isHost: true })).toBe(false)
    expect(a.sync.offer({ v: 1, tabs: [{ id: 5 }], by: 'x' }, { name: 'B', isHost: true })).toBe(
      false
    )
    expect(a.applied).toEqual([])
    expect(a.settings.ui.libraryTabs).toEqual([tab('t1', { sort: 'size' })])
  })

  it("a client's change reaches the host, then the host's other client", async () => {
    const host = await pc('host', [tab('t1')])
    const a = await pc('client-a', [tab('x1')])
    const b = await pc('client-b', [tab('y1')])
    // First contact (all never edited): every client takes the host's tabs.
    exchange(a, host, 'A')
    exchange(b, host, 'B')
    expect(a.settings.ui.libraryTabs).toEqual([tab('t1')])
    expect(b.settings.ui.libraryTabs).toEqual([tab('t1')])
    expect(host.applied).toEqual([])

    // A edits; its next exchange gives the host the change; B's next exchange takes it.
    a.clock.now = NOW + 60_000
    a.edit([tab('t1'), withPlatforms('t2', ['only-on-a'])])
    exchange(a, host, 'A')
    expect(host.settings.ui.libraryTabs).toEqual([tab('t1'), withPlatforms('t2', ['only-on-a'])])
    exchange(b, host, 'B')
    expect(b.settings.ui.libraryTabs).toEqual([tab('t1'), withPlatforms('t2', ['only-on-a'])])

    // The host edits later: both clients take it.
    host.clock.now = NOW + 120_000
    host.edit([tab('t2', { sort: 'recent' })])
    exchange(a, host, 'A')
    exchange(b, host, 'B')
    expect(a.settings.ui.libraryTabs).toEqual([tab('t2', { sort: 'recent' })])
    expect(b.settings.ui.libraryTabs).toEqual([tab('t2', { sort: 'recent' })])

    // Nothing more moves once all agree.
    const counts = [host, a, b].map((x) => x.applied.length)
    exchange(a, host, 'A')
    exchange(b, host, 'B')
    expect([host, a, b].map((x) => x.applied.length)).toEqual(counts)
  })

  it("a client of two never-edited hosts takes the first one's copy and leaves each host its own", async () => {
    const h1 = await pc('host-1', [tab('h1')])
    const h2 = await pc('host-2', [tab('h2')])
    const c = await pc('client', [tab('c')])
    for (let i = 0; i < 3; i++) {
      exchange(c, h1)
      exchange(c, h2)
    }
    expect(c.settings.ui.libraryTabs).toEqual([tab('h1')])
    expect(c.sync.doc()?.updatedAt).toBe(NEVER_EDITED)
    expect(h2.settings.ui.libraryTabs).toEqual([tab('h2')])
    expect(h2.applied).toEqual([])
    expect(c.applied).toHaveLength(1)
    const counts = [h1, h2, c].map((x) => x.applied.length)
    exchange(c, h1)
    exchange(c, h2)
    expect([h1, h2, c].map((x) => x.applied.length)).toEqual(counts)
  })

  it("a new host without tabs yet never wipes a client's; it takes the client's instead", async () => {
    const host = await pc('host', null)
    const c = await pc('client', [tab('c1'), tab('c2')])
    exchange(c, host)
    expect(c.applied).toEqual([])
    expect(c.settings.ui.libraryTabs).toEqual([tab('c1'), tab('c2')])
    expect(host.settings.ui.libraryTabs).toEqual([tab('c1'), tab('c2')])
    expect(host.sync.doc()?.updatedAt).toBe(NEVER_EDITED)
  })

  it('never applies an empty list, even a newer one', async () => {
    const a = await pc('pc-a', [tab('t1')])
    expect(a.sync.offer(doc([], at(5), 'pc-b'), { name: 'B', isHost: true })).toBe(false)
    expect(a.applied).toEqual([])
  })

  it("refuses a newer PlayOut's copy whole, so an older PC keeps (and serves) its tabs", async () => {
    const host = await pc('host', [tab('t1'), tab('t2')])
    const newer = { ...tab('t3'), filters: { ...tab('t3').filters, newThing: ['x'] } }
    const raw = doc([tab('t1'), newer as LibraryTabDef], at(5), 'client')
    expect(host.sync.offer(raw, { name: 'Client', isHost: false })).toBe(false)
    expect(host.applied).toEqual([])
    expect(host.sync.doc()?.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('first tabs built after an empty copy are adopted as never edited, not stamped', async () => {
    const a = await pc('pc-a', null)
    let changes = 0
    a.sync.onLocalChange(() => changes++)
    a.edit([tab('d1')])
    expect(a.sync.doc()).toEqual(doc([tab('d1')], NEVER_EDITED, 'pc-a'))
    expect(changes).toBe(0)
  })

  it("corrects for the other PC's clock", async () => {
    const a = await pc('pc-a', [tab('t1')])
    a.clock.now = NOW + 60_000
    a.edit([tab('t1', { sort: 'recent' })])
    // Edited 30 s after this PC's change in real time, on a clock 2 minutes ahead.
    const theirs = doc([tab('t1', { sort: 'size' })], at(1 + 0.5 + 2), 'pc-b')
    expect(a.sync.offer(theirs, { name: 'B', isHost: false, skewMs: 120_000 })).toBe(true)
    expect(a.sync.doc()?.updatedAt).toBe(at(1.5))
    // Raw time after this PC's next change, but 30 s before it once the 2 minutes are taken off: not taken.
    const older = doc([tab('t1', { sort: 'added' })], at(4.5), 'pc-b')
    a.clock.now = NOW + 3 * 60_000
    a.edit([tab('t1', { sort: 'release' })])
    expect(a.sync.offer(older, { name: 'B', isHost: false, skewMs: 120_000 })).toBe(false)
  })
})
