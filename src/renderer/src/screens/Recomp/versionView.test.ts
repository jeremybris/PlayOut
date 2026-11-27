import type { RecompRelease } from '@shared/recomp'
import { describe, expect, it } from 'vitest'
import {
  newestInstallable,
  releaseInfo,
  sameRecompTag,
  showAllFocus,
  switchConfirm,
  versionActionLabel,
  versionChip,
  versionDesc,
  versionItems,
  versionText,
  wouldPin
} from './versionView'

const rel = (tag: string, patch: Partial<RecompRelease> = {}): RecompRelease => ({
  tag,
  name: tag,
  publishedAt: '2026-10-01T12:00:00',
  prerelease: false,
  notes: '',
  url: '',
  asset: { name: `${tag}.zip`, size: 1, sha256: null },
  ...patch
})

// Newest first, as main and the mock give them, with main's newest and pin marks.
const releases = [
  rel('v5-beta', { prerelease: true }),
  rel('v4', { newest: true }),
  rel('v3a', { asset: null }),
  rel('v3', { pins: true }),
  rel('v2', { pins: true })
]

const row = (
  patch: {
    update?: string | null
    release?: { prerelease: boolean; latest: string | null } | null
  } = {},
  installed: { tag?: string; pinnedTag?: string | null } = {}
): Parameters<typeof versionChip>[0] => ({
  update: null,
  release: { prerelease: false, latest: 'v4' },
  ...patch,
  installed: { tag: 'v4', pinnedTag: null, ...installed }
})

describe('versionView', () => {
  it('compares tags loosely', () => {
    expect(sameRecompTag('v1.2', '1.2')).toBe(true)
    expect(sameRecompTag('V1.2', 'v1.2')).toBe(true)
    expect(sameRecompTag('v1.2', 'v1.3')).toBe(false)
  })

  it('chips the version in use', () => {
    expect(versionChip(row())).toBe('Latest')
    expect(versionChip(row({}, { tag: 'v3', pinnedTag: 'v3' }))).toBe('Older version')
    expect(versionChip(row({ update: 'v4' }, { tag: 'v3' }))).toBe('Older version')
    expect(
      versionChip(row({ release: { prerelease: true, latest: 'v4' } }, { tag: 'v5-beta' }))
    ).toBe('Pre-release')
    // Not checked yet: no chip.
    expect(versionChip(row({ release: null }))).toBeNull()
  })

  it('reads the chip from a release list (the Recompilation page)', () => {
    expect(newestInstallable(releases)?.tag).toBe('v4')
    expect(releaseInfo(releases, 'v4')).toEqual({ prerelease: false, latest: 'v4' })
    expect(releaseInfo(releases, '5-beta')).toEqual({ prerelease: true, latest: 'v4' })
    expect(versionChip(row({ release: releaseInfo(releases, 'v3') }, { tag: 'v3' }))).toBeNull()
    expect(versionChip(row({ release: releaseInfo(releases, 'v4') }))).toBe('Latest')
    expect(releaseInfo([rel('v1', { asset: null })], 'v1')).toEqual({
      prerelease: false,
      latest: null
    })
  })

  it('takes the newest from main, not from the list order', () => {
    // A backport published after v2.0 sits first; main still marks v2.0 the newest (and pins the backport).
    const backport = [rel('v1.9.1', { pins: true }), rel('v2.0', { newest: true })]
    expect(newestInstallable(backport)?.tag).toBe('v2.0')
    expect(versionChip(row({ release: releaseInfo(backport, 'v2.0') }, { tag: 'v2.0' }))).toBe(
      'Latest'
    )
    expect(wouldPin(backport[0]!)).toBe(true)
    expect(wouldPin(backport[1]!)).toBe(false)
    expect(switchConfirm('X', backport[0]!).message).toMatch(/PlayOut stays on v1.9.1/)
    // Unmarked (no newest known): no chip guessed.
    expect(releaseInfo([rel('v1')], 'v1').latest).toBeNull()
  })

  it('keeps focus in the list when Show all is pressed', () => {
    const items = versionItems(
      [
        rel('v3', { notes: 'n' }),
        rel('v2', { asset: null, notes: 'n' }),
        rel('v1', { asset: null })
      ],
      { tag: 'v3' }
    )
    expect(showAllFocus(items, 0)).toEqual(['version:v3:notes', 'versions'])
    expect(showAllFocus(items, 1)).toEqual(['version:v2:notes', 'versions'])
    expect(showAllFocus(items, 2)).toEqual(['versions'])
    expect(showAllFocus(items, 3)).toEqual(['versions'])
    expect(showAllFocus(versionItems([rel('v9')], { tag: 'v1' }), 0)).toEqual([
      'version:v9:use',
      'versions'
    ])
  })

  it('words the Version row', () => {
    expect(versionText({ tag: 'v4', publishedAt: null, updatedAt: '' })).toBe('v4')
    expect(versionText({ tag: 'v4', publishedAt: '2026-10-01T12:00:00', updatedAt: '' })).toMatch(
      /^v4 · .+/
    )
    expect(versionDesc({ pinnedTag: 'v3' })).toMatch(/^Pinned to v3: automatic updates/)
    expect(versionDesc({ pinnedTag: null })).toMatch(/saves and settings are kept/)
  })

  it('lists the releases newest first, the one in use marked, no-download ones explained', () => {
    const items = versionItems(releases, { tag: '3' })
    expect(items.map((i) => i.release.tag)).toEqual(['v5-beta', 'v4', 'v3a', 'v3', 'v2'])
    expect(items.filter((i) => i.inUse).map((i) => i.release.tag)).toEqual(['v3'])
    expect(items.find((i) => i.release.tag === 'v3a')?.unavailable).toMatch(/No Windows download/)
    expect(items.find((i) => i.release.tag === 'v4')?.unavailable).toBeNull()
    // Not installed (the page's Releases): none in use, and each one installs.
    expect(versionItems(releases, undefined).some((i) => i.inUse)).toBe(false)
    expect(versionActionLabel(true)).toBe('Use this version')
    expect(versionActionLabel(false)).toBe('Install this one')
  })

  it('says when a choice is kept (pinned)', () => {
    const at = (tag: string): RecompRelease => releases.find((r) => r.tag === tag)!
    expect(wouldPin(at('v3'))).toBe(true)
    expect(wouldPin(at('v4'))).toBe(false)
    // A pre-release newer than the newest full release follows updates.
    expect(wouldPin(at('v5-beta'))).toBe(false)
    expect(switchConfirm('Doom64EX+', at('v4'))).toEqual({
      title: 'Switch Doom64EX+ to v4?',
      message: 'Your saves and settings are kept.'
    })
    expect(switchConfirm('Doom64EX+', at('v2')).message).toMatch(
      /^Your saves and settings are kept\. PlayOut stays on v2/
    )
  })
})
