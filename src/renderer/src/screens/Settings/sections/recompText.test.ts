import type { RecompCatalogStatus, RecompCloudState, RecompRow } from '@shared/recomp'
import { describe, expect, it } from 'vitest'
import {
  canRemoveSave,
  catalogFetched,
  catalogLead,
  cloudStatusText,
  keptSaveText,
  progressText,
  rowDetail,
  saveSourceText,
  updateAllLabel,
  versionOptions
} from './recompText'

const NOW = new Date('2026-11-14T12:00:00')

const catalog = (patch: Partial<RecompCatalogStatus> = {}): RecompCatalogStatus => ({
  fetchedAt: { 'decomp-buddy': '2026-11-14T08:00:00', recomplauncher: '2026-11-12T08:00:00' },
  entries: 187,
  titles: 164,
  matchedGames: 2,
  offline: [],
  refreshing: false,
  ...patch
})

const cloud = (patch: Partial<RecompCloudState> = {}): RecompCloudState => ({
  enabled: true,
  syncedHash: 'a',
  localHash: 'a',
  syncedAt: '2026-11-13T10:00:00',
  pending: false,
  error: null,
  conflict: null,
  ...patch
})

const row = {
  entry: { id: 'github:a/b', name: 'Doom64EX+' },
  installed: { tag: 'v4.0.0.3', diskBytes: 96 * 1024 * 1024, verified: 'scanned' },
  alternatives: [
    { id: 'github:c/d', name: 'Doom64EX', installed: false },
    { id: 'github:e/f', name: 'Other', installed: true }
  ]
} as unknown as RecompRow

describe('recompText', () => {
  it('describes the catalog', () => {
    expect(catalogLead(catalog())).toBe(
      '187 recompilations in the catalogs, for 2 games in your library.'
    )
    expect(catalogLead(catalog({ matchedGames: 0 }))).toContain('for no games')
    expect(catalogLead(catalog({ entries: 0, offline: ['decomp-buddy'] }))).toMatch(
      /could not be reached/
    )
    expect(catalogLead(catalog({ entries: 0 }))).toMatch(/not been loaded/)
  })

  it('says when the catalogs were fetched and which are offline', () => {
    expect(catalogFetched(catalog(), NOW)).toBe('Updated today')
    expect(catalogFetched(catalog({ offline: ['recomplauncher'] }), NOW)).toBe(
      'Updated today · RecompLauncher could not be reached (using the saved copy)'
    )
    expect(
      catalogFetched(catalog({ fetchedAt: { 'decomp-buddy': null, recomplauncher: null } }), NOW)
    ).toBe('Never updated')
  })

  it('puts install phases in words', () => {
    const base = { id: 'x', progress: null, bytes: null, total: null, message: null, warning: null }
    expect(progressText({ ...base, phase: 'queued' })).toBe('Waiting…')
    expect(
      progressText({ ...base, phase: 'downloading', progress: 0.426, total: 28 * 1024 * 1024 })
    ).toBe('Downloading… 42% of 28 MB')
    expect(progressText({ ...base, phase: 'failed', message: 'No space' })).toBe('Failed: No space')
    expect(progressText({ ...base, phase: 'done' })).toBe('Done')
  })

  it('details a row', () => {
    expect(rowDetail(row, 'Doom 64')).toBe('Doom 64 · v4.0.0.3 · 96 MB on disk')
    const unverified = {
      ...row,
      installed: { ...row.installed, diskBytes: null, verified: 'unverified' }
    } as RecompRow
    expect(rowDetail(unverified, null)).toBe('v4.0.0.3 · not verified')
  })

  it('explains where the saves come from', () => {
    expect(saveSourceText('catalog', 0)).toMatch(/next time you play/)
    expect(saveSourceText('user', 1)).toBe('Chosen by you.')
    expect(saveSourceText('detected', 2)).toBe('Found by PlayOut.')
    expect(saveSourceText(null, 0)).toMatch(/Find automatically/)
  })

  it('keeps Remove off the one folder the catalog or the developer names (it would come straight back)', () => {
    expect(canRemoveSave('catalog', 1)).toBe(false)
    expect(canRemoveSave('developer', 1)).toBe(false)
    expect(canRemoveSave('catalog', 2)).toBe(true)
    expect(canRemoveSave('user', 1)).toBe(true)
    expect(canRemoveSave('detected', 1)).toBe(true)
    expect(canRemoveSave('install', 1)).toBe(true)
    expect(keptSaveText('catalog', 1)).toMatch(/the catalog names it.*save copy off/)
    expect(keptSaveText('developer', 1)).toMatch(/settings file names it/)
    expect(keptSaveText('catalog', 2)).toBeNull()
    expect(keptSaveText('user', 1)).toBeNull()
    expect(keptSaveText('catalog', 0)).toBeNull()
  })

  it('states the save copy in the Emulation folder', () => {
    expect(cloudStatusText(cloud({ enabled: false }), NOW)).toMatch(/not copied/)
    expect(cloudStatusText(cloud(), NOW)).toBe('Copied yesterday.')
    expect(cloudStatusText(cloud({ syncedAt: null }), NOW)).toBe(
      'Copied before and after you play.'
    )
    expect(cloudStatusText(cloud({ pending: true }), NOW)).toMatch(/Waiting to copy.*Emulation/)
    expect(cloudStatusText(cloud({ pending: true, error: 'Drive is offline' }), NOW)).toBe(
      'Waiting to copy: Drive is offline'
    )
    const conflict = cloudStatusText(
      cloud({
        conflict: { localAt: '2026-11-13', cloudAt: '2026-11-14', cloudDevice: 'LIVING-ROOM' }
      }),
      NOW
    )
    expect(conflict).toMatch(/Emulation folder's copy, from LIVING-ROOM.*Pick the ones to keep/)
    expect(conflict).not.toMatch(/cloud/i)
  })

  it('labels Update all and the version options', () => {
    expect(updateAllLabel(0)).toBe('Update all')
    expect(updateAllLabel(3)).toBe('Update all (3)')
    expect(versionOptions(row)).toEqual([
      { value: 'github:a/b', label: 'Doom64EX+' },
      { value: 'github:c/d', label: 'Doom64EX (installs it)' },
      { value: 'github:e/f', label: 'Other' }
    ])
  })
})
