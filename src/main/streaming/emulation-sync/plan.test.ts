import { describe, expect, it } from 'vitest'
import { heldKeys, planSync, type BaseEntry } from './plan'
import { cleanSyncPath, isExcluded, OLD_PS3_HDD, scopeFor, syncKey, UPDATES_DLC_KEY } from './rules'
import type { SyncFile } from './scan'

const file = (path: string, hash: string, mtimeMs = 1000): SyncFile => ({
  path,
  size: hash.length,
  mtimeMs,
  hash: hash.padEnd(40, '0')
})
const map = (...files: SyncFile[]): Map<string, SyncFile> =>
  new Map(files.map((f) => [syncKey(f.path), f]))
const base = (...entries: [string, string][]): Map<string, BaseEntry> =>
  new Map(entries.map(([p, h]) => [syncKey(p), { path: p, hash: h.padEnd(40, '0') }]))

function plan(
  local: Map<string, SyncFile>,
  remote: Map<string, SyncFile>,
  b: Map<string, BaseEntry>,
  skewMs = 0
): string[] {
  return planSync({ local, remote, base: b, hold: new Set(), skewMs }).map((a) => {
    switch (a.kind) {
      case 'download':
        return `download ${a.key}${a.backupLocal ? ' (backup)' : ''}`
      case 'upload':
        return `upload ${a.key}${a.backupRemote ? ' (backup)' : ''} expect=${a.expect?.slice(0, 2) ?? 'none'}`
      case 'deleteLocal':
        return `deleteLocal ${a.key}`
      case 'deleteRemote':
        return `deleteRemote ${a.key}`
      case 'record':
        return `record ${a.key} ${a.entry ? 'present' : 'gone'}`
    }
  })
}

describe('planSync', () => {
  it('first sync: merges both folders; same contents need no copy', () => {
    expect(
      plan(
        map(file('saves/a.srm', 'aa'), file('bios/same.bin', 'ss')),
        map(file('saves/b.srm', 'bb'), file('bios/same.bin', 'ss')),
        new Map()
      )
    ).toEqual([
      'record bios/same.bin present',
      'upload saves/a.srm expect=none',
      'download saves/b.srm'
    ])
  })

  it('first sync: a file both have with different contents goes to the newer, the other is backed up', () => {
    expect(
      plan(map(file('saves/x', 'l1', 2000)), map(file('saves/x', 'r1', 1000)), new Map())
    ).toEqual(['upload saves/x (backup) expect=r1'])
    expect(
      plan(map(file('saves/x', 'l1', 1000)), map(file('saves/x', 'r1', 2000)), new Map())
    ).toEqual(['download saves/x (backup)'])
  })

  it('puts the host’s times on this PC’s clock before comparing', () => {
    // The host's clock runs 10 s ahead: its 2000 is this PC's -8000, older than the local 1000.
    expect(plan(map(file('s', 'l1', 1000)), map(file('s', 'r1', 2000)), new Map(), 10_000)).toEqual(
      ['upload s (backup) expect=r1']
    )
  })

  it('a tie goes to the host', () => {
    expect(plan(map(file('s', 'l1', 1000)), map(file('s', 'r1', 1000)), new Map())).toEqual([
      'download s (backup)'
    ])
  })

  it('a change on one side goes to the other, without a backup', () => {
    const b = base(['s', 'o1'])
    expect(plan(map(file('s', 'n1')), map(file('s', 'o1')), b)).toEqual(['upload s expect=o1'])
    expect(plan(map(file('s', 'o1')), map(file('s', 'n1')), b)).toEqual(['download s'])
  })

  it('a deletion on one side goes to the other', () => {
    const b = base(['s', 'o1'])
    expect(plan(new Map(), map(file('s', 'o1')), b)).toEqual(['deleteRemote s'])
    expect(plan(map(file('s', 'o1')), new Map(), b)).toEqual(['deleteLocal s'])
  })

  it('a deletion never beats a change: the changed copy comes back', () => {
    const b = base(['s', 'o1'])
    expect(plan(map(file('s', 'n1')), new Map(), b)).toEqual(['upload s expect=none'])
    expect(plan(new Map(), map(file('s', 'n1')), b)).toEqual(['download s'])
  })

  it('both deleted, or both changed the same way: only the base moves', () => {
    expect(plan(new Map(), new Map(), base(['s', 'o1']))).toEqual(['record s gone'])
    expect(plan(map(file('s', 'n1')), map(file('s', 'n1')), base(['s', 'o1']))).toEqual([
      'record s present'
    ])
  })

  it('nothing changed: nothing to do', () => {
    expect(plan(map(file('s', 'o1')), map(file('s', 'o1')), base(['s', 'o1']))).toEqual([])
  })

  it('compares paths without letter case', () => {
    expect(plan(map(file('Saves/A.srm', 'aa')), map(file('saves/a.srm', 'aa')), new Map())).toEqual(
      ['record saves/a.srm present']
    )
  })

  it('leaves held files alone, whatever changed', () => {
    const local = map(file('s', 'n1'), file('t', 'n2'))
    const actions = planSync({
      local,
      remote: new Map(),
      base: base(['s', 'o1'], ['t', 'o2']),
      hold: new Set(['s']),
      skewMs: 0
    })
    expect(actions.map((a) => a.key)).toEqual(['t'])
  })
})

describe('heldKeys', () => {
  it('holds files written moments ago on either PC (each by its own clock) and unreadable ones', () => {
    const hold = heldKeys({
      local: map(file('new-here', 'a', 95_000), file('old-here', 'b', 10_000)),
      remote: map(file('new-there', 'c', 495_000), file('old-there', 'd', 10_000)),
      localNow: 100_000,
      remoteNow: 500_000,
      settleMs: 30_000,
      unsettled: ['locked']
    })
    expect([...hold].sort()).toEqual(['locked', 'new-here', 'new-there'])
  })
})

describe('rules', () => {
  const scope = scopeFor('C:\\Emu', null)

  it('leaves out roms and texturepacks with everything in them, in any letter case, and PlayOut’s leftovers', () => {
    expect(isExcluded('roms', scope)).toBe(true)
    expect(isExcluded('ROMS/psx/game.chd', scope)).toBe(true)
    expect(isExcluded('texturepacks/dolphin/x.png', scope)).toBe(true)
    expect(isExcluded('TexturePacks', scope)).toBe(true)
    expect(isExcluded('saves/roms/x.srm', scope)).toBe(false)
    expect(isExcluded('saves/romsave.srm', scope)).toBe(false)
    expect(isExcluded('bios/scph1001.bin', scope)).toBe(false)
    expect(isExcluded('saves/a.srm.playout-sync', scope)).toBe(true)
    expect(isExcluded('storage/x/savedata.playout-old-2/f', scope)).toBe(true)
    expect(isExcluded('storage/x/savedata.playout-new', scope)).toBe(true)
  })

  it('also leaves out a ROM folder inside the Emulation folder', () => {
    const s = scopeFor('C:\\Emu', 'c:\\emu\\Games\\')
    expect(s.extraExcluded).toEqual([OLD_PS3_HDD, UPDATES_DLC_KEY, 'games'])
    expect(isExcluded('games/psx/a.chd', s)).toBe(true)
    expect(isExcluded('gamesaves/a', s)).toBe(false)
    expect(scopeFor('C:\\Emu', 'D:\\Roms').extraExcluded).toEqual([OLD_PS3_HDD, UPDATES_DLC_KEY])
    expect(scopeFor('C:\\Emu', 'C:\\Emu').extraExcluded).toEqual([OLD_PS3_HDD, UPDATES_DLC_KEY])
    // PlayOut's old PS3 HDD place: each PC moves its own copy, and none deletes another's.
    expect(isExcluded('storage/rpcs3/dev_hdd0/game/BLUS30443/PARAM.SFO', s)).toBe(true)
    expect(isExcluded('storage/rpcs3/other.txt', s)).toBe(false)
  })

  it('never syncs Updates and DLC, and names it as excluded for the other PC', () => {
    const s = scopeFor('C:\\Emu', null)
    expect(UPDATES_DLC_KEY).toBe('updates and dlc')
    expect(s.extraExcluded).toContain('updates and dlc')
    expect(isExcluded('Updates and DLC/PS3/dev_hdd0/game/x', s)).toBe(true)
    expect(isExcluded('updates and dlc/ps3/dev_hdd0/game/x', s)).toBe(true)
    expect(isExcluded('UPDATES AND DLC/Switch/title.nsp', s)).toBe(true)
    expect(isExcluded('Updates and DLC', s)).toBe(true)
    expect(isExcluded('Updates and DLC2/x', s)).toBe(false)
    expect(isExcluded('saves/Updates and DLC/x', s)).toBe(false)
  })

  it('checks paths from the other PC', () => {
    expect(cleanSyncPath('saves/a.srm', scope)).toBe('saves/a.srm')
    expect(cleanSyncPath('saves\\a.srm', scope)).toBe('saves/a.srm')
    for (const bad of ['../x', 'C:/x', '/abs', 'saves/../../x', 'a/b:c', 'roms/x', '', 5, null])
      expect(cleanSyncPath(bad, scope)).toBeNull()
  })
})
