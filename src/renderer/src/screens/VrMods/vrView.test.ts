import type { InstalledVrMod, VrModEntry } from '@shared/vr-mods'
import { describe, expect, it } from 'vitest'
import { formatBytes } from '../../lib/format'
import {
  filterCounts,
  filterMods,
  isQuestMod,
  isQuestOnlyMod,
  modAction,
  modFacts,
  modLinks,
  searchMods,
  shownMods,
  siteName,
  sortMods,
  vrProgressText
} from './vrView'

function mod(over: Partial<VrModEntry> & Pick<VrModEntry, 'id' | 'title'>): VrModEntry {
  return {
    author: '',
    date: '2026-10-01',
    status: '',
    kind: 'debut',
    tags: ['PCVR'],
    summary: '',
    highlights: [],
    page: null,
    github: null,
    thread: null,
    video: null,
    reddit: null,
    outside: false,
    accent: null,
    ...over
  }
}

const MODS = [
  mod({
    id: 'ff16',
    title: 'Final Fantasy 16 VR',
    author: 'markmon',
    date: '2026-10-29',
    kind: 'alpha',
    github: { owner: 'mark-mon', repo: 'final-fantasy-16-vr', tag: null }
  }),
  mod({ id: 'uevr', title: 'UEVR nightly', date: '2026-10-12', kind: 'tool' }),
  mod({ id: 'pinball', title: 'Pinball', date: '2026-10-05', tags: ['Quest standalone'] }),
  mod({ id: 'profile', title: 'Alan Wake profile', date: '2026-10-05', kind: 'profile' })
]

describe('VR mod browser view', () => {
  it('searches titles, authors, tags and the GitHub repository (accents and case ignored)', () => {
    expect(searchMods(MODS, 'fantasy').map((m) => m.id)).toEqual(['ff16'])
    expect(searchMods(MODS, 'MARKMON').map((m) => m.id)).toEqual(['ff16'])
    expect(searchMods(MODS, 'quest').map((m) => m.id)).toEqual(['pinball'])
    expect(searchMods(MODS, 'finalfantasy16').map((m) => m.id)).toEqual(['ff16'])
    expect(searchMods(MODS, '').length).toBe(4)
  })

  it('filters by kind, Quest standalone and downloaded', () => {
    expect(filterMods(MODS, 'alpha', {}).map((m) => m.id)).toEqual(['ff16'])
    expect(filterMods(MODS, 'tool', {}).map((m) => m.id)).toEqual(['uevr'])
    expect(filterMods(MODS, 'quest', {}).map((m) => m.id)).toEqual(['pinball'])
    expect(filterMods(MODS, 'installed', { uevr: {} }).map((m) => m.id)).toEqual(['uevr'])
    expect(filterCounts(MODS, {})).toMatchObject({ all: 4, debut: 1, profile: 1, installed: 0 })
  })

  it('tells Quest standalone builds from PCVR mods that only mention a Quest', () => {
    expect(isQuestMod({ tags: ['Quest 3 standalone'] })).toBe(true)
    expect(isQuestMod({ tags: ['experimental Quest APK'] })).toBe(true)
    expect(isQuestMod({ tags: ['PCVR (Quest Link / Air Link tested)'] })).toBe(false)
    expect(isQuestMod({ tags: ['no SideQuest needed'] })).toBe(false)
  })

  it('sorts newest first, oldest first (list order within a day) or by name', () => {
    expect(sortMods(MODS, 'newest').map((m) => m.id)).toEqual([
      'ff16',
      'uevr',
      'pinball',
      'profile'
    ])
    expect(sortMods(MODS, 'oldest').map((m) => m.id)).toEqual([
      'pinball',
      'profile',
      'uevr',
      'ff16'
    ])
    expect(sortMods(MODS, 'title').map((m) => m.id)).toEqual(['profile', 'ff16', 'pinball', 'uevr'])
    expect(
      shownMods(MODS, { query: 'pcvr', filter: 'tool', sort: 'title', installed: {} }).map(
        (m) => m.id
      )
    ).toEqual(['uevr'])
  })

  it('picks the main action: download, update, page only, busy', () => {
    const installed = { tag: 'v1' } as InstalledVrMod
    expect(modAction(MODS[0]!, undefined, undefined, false)).toBe('download')
    expect(modAction(MODS[0]!, installed, 'v2', false)).toBe('update')
    expect(modAction(MODS[0]!, installed, undefined, false)).toBe('downloaded')
    expect(modAction(MODS[1]!, undefined, undefined, false)).toBe('page')
    expect(modAction(MODS[0]!, undefined, undefined, true)).toBe('busy')
  })

  it('offers only the page of a Quest-only GitHub mod', () => {
    const quest = mod({
      id: 'pinball',
      title: 'Pinball (Quest port)',
      tags: ['Quest standalone', 'native mod'],
      github: { owner: 'o', repo: 'r', tag: null }
    })
    const both = { ...quest, tags: ['Quest standalone and PCVR (Windows build)'] }
    expect(isQuestOnlyMod(quest)).toBe(true)
    expect(isQuestOnlyMod(both)).toBe(false)
    expect(isQuestOnlyMod(mod({ id: 'x', title: 'X', tags: ['PCVR + Quest standalone'] }))).toBe(
      false
    )
    expect(modAction(quest, undefined, undefined, false)).toBe('page')
    expect(modAction(both, undefined, undefined, false)).toBe('download')
    // Downloaded anyway (a release with a PC file): it is updated like any other.
    expect(modAction(quest, { tag: 'v1' } as InstalledVrMod, 'v2', false)).toBe('update')
  })

  it('words progress as saving, never installing, and shows a removal', () => {
    const p = { id: 'a', progress: null, bytes: null, total: null, message: null, warning: null }
    expect(vrProgressText({ ...p, phase: 'installing' })).toBe('Saving to the VR Mods folder…')
    expect(vrProgressText({ ...p, phase: 'removing' })).toBe('Removing…')
    expect(vrProgressText({ ...p, phase: 'extracting' })).toBe('Unpacking…')
    expect(vrProgressText({ ...p, phase: 'failed', message: 'x' })).toBe('Failed: x')
  })

  it('names the sites of links and lists the extra links', () => {
    expect(siteName('https://www.nexusmods.com/game/mods/1')).toBe('Nexus Mods')
    expect(siteName('https://someone.itch.io/mod')).toBe('itch.io')
    expect(siteName('https://example.org/x')).toBe('example.org')
    expect(siteName(null)).toBe('')
    expect(
      modLinks({
        video: 'https://youtu.be/x',
        reddit: null,
        thread: 'https://discord.com/channels/1/2'
      })
    ).toEqual([
      { id: 'video', label: 'Video', url: 'https://youtu.be/x' },
      { id: 'thread', label: 'Source thread (Discord)', url: 'https://discord.com/channels/1/2' }
    ])
  })

  it('writes the facts line', () => {
    expect(modFacts({ ...MODS[0]!, status: 'v0.9.0 beta' }, undefined)).toEqual([
      'Status: v0.9.0 beta'
    ])
    expect(
      modFacts(MODS[1]!, {
        tag: 'nightly',
        verified: 'unverified',
        diskBytes: 5 * 1024 * 1024
      } as InstalledVrMod)
    ).toEqual(['downloaded nightly (not verified)', `${formatBytes(5 * 1024 * 1024)} on disk`])
  })
})
