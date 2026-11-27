import { describe, expect, it } from 'vitest'
import type { UpgradeProgress } from '@shared/upgrades'
import { blockedOnly, dllHint, shaderHint, stoppableUpgrade } from './upgradeMenu'

const compressing: UpgradeProgress = {
  gameId: 'steam:620',
  upgrade: 'compress',
  state: 'running',
  progress: 0.3,
  message: 'Compressing…'
}

describe('blockedOnly', () => {
  it('shows only the reason for a blocked game with nothing running', () => {
    expect(blockedOnly({ blocked: 'Close the game first.', busy: null }, null)).toBe(
      'Close the game first.'
    )
    expect(blockedOnly({ blocked: null, busy: null }, null)).toBeNull()
  })

  it('keeps the rows (and so Stop) when the game was started while an upgrade runs', () => {
    expect(blockedOnly({ blocked: 'Close the game first.', busy: 'compress' }, null)).toBeNull()
    expect(blockedOnly({ blocked: 'Close the game first.', busy: null }, compressing)).toBeNull()
  })
})

describe('stoppableUpgrade', () => {
  it('offers Stop for running shaders and compression, from the progress or the status', () => {
    expect(stoppableUpgrade({ busy: null }, compressing)).toBe('compress')
    // The menu reopened (or the app reloaded) without the progress line: the status still says what runs.
    expect(stoppableUpgrade({ busy: 'shaders' }, null)).toBe('shaders')
    expect(stoppableUpgrade({ busy: 'dlls' }, null)).toBeNull()
    expect(stoppableUpgrade(null, null)).toBeNull()
  })
})

describe('shaderHint', () => {
  const done = (iso: string): string => iso.slice(0, 10)
  it('shows why the last run could not be done as a hint, before the date', () => {
    expect(
      shaderHint(
        { unavailable: null, note: "SCSKiller doesn't list this game", compiledAt: null },
        done
      )
    ).toBe("SCSKiller doesn't list this game")
    expect(
      shaderHint(
        { unavailable: 'Not available for Intel graphics', note: 'x', compiledAt: null },
        done
      )
    ).toBe('Not available for Intel graphics')
    expect(
      shaderHint({ unavailable: null, note: null, compiledAt: '2026-11-19T10:00:00.000Z' }, done)
    ).toBe('Done 2026-11-19')
    expect(shaderHint({ unavailable: null, note: null, compiledAt: null }, done)).toBe(
      'Removes shader stutter'
    )
  })
})

describe('dllHint', () => {
  const file = { relPath: 'x.dll', version: '1.0.0.0', swapped: false }
  const found = [{ ...file, kind: 'dlss' as const }]

  it('sums up every kind: the ones to update with friendly versions, then the others by name', () => {
    expect(
      dllHint({
        found,
        kinds: [
          { kind: 'fsr-dx12', version: '3.1.4', latest: '3.1.4', updatable: false },
          { kind: 'dlss', version: '3.5.10', latest: '310.9.16', updatable: true },
          { kind: 'xess', version: '1.3.0.28', latest: '2.0.2.68', updatable: false }
        ]
      })
    ).toBe('DLSS 3.5 → 310.9 · FSR · XeSS')
  })

  it('keeps the full versions when the short ones read the same, and names a shared kind once', () => {
    expect(
      dllHint({
        found,
        kinds: [
          { kind: 'fsr-dx12', version: '3.1.1', latest: '3.1.4', updatable: true },
          { kind: 'fsr-vk', version: '3.1.4', latest: '3.1.4', updatable: false }
        ]
      })
    ).toBe('FSR 3.1.1 → 3.1.4')
  })

  it('says up to date only when every newest version is known', () => {
    const kinds = [
      { kind: 'dlss' as const, version: '310.9.16', latest: '310.9.16', updatable: false }
    ]
    expect(dllHint({ found, kinds })).toBe('Up to date')
    expect(dllHint({ found, kinds: [{ ...kinds[0]!, latest: null }] })).toBe(
      'Newest versions unknown'
    )
    expect(dllHint({ found: [], kinds: [] })).toBe('None in this game')
  })
})
