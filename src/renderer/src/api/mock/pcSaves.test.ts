import type { Game } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { createEmitter } from './emitter'
import { createPcSavesMock } from './pcSaves'

function setup(): ReturnType<typeof createPcSavesMock> {
  const games = new Map<string, Game>([
    ['manual:hk', { id: 'manual:hk', source: 'manual', title: 'Hollow Knight' } as Game],
    ['steam:1', { id: 'steam:1', source: 'steam', title: 'Portal' } as Game]
  ])
  return createPcSavesMock({
    emitter: createEmitter(),
    games,
    emulationDir: () => 'C:\\Users\\me\\Documents\\Emulation',
    featureOn: () => true,
    runningId: () => null,
    now: () => '2026-11-26T10:00:00.000Z'
  })
}

describe('PC Saves mock', () => {
  it('copies, asks about large folders, and blocks Play while a question is open', async () => {
    const m = setup()
    expect(await m.api.getPcSaves('steam:1')).toBeNull()
    expect((await m.api.getPcSaves('manual:hk'))?.folder).toBeNull()
    expect((await m.api.inspectPcSaveFolder('manual:hk', 'D:\\big saves')).large).toBe(true)
    await expect(m.api.inspectPcSaveFolder('manual:hk', 'D:\\')).rejects.toThrow(/too broad/)
    const set = await m.api.setPcSaveFolder('manual:hk', 'D:\\HK')
    expect(set.syncedAt).not.toBeNull()
    expect(m.blocksLaunch('manual:hk')).toBe(false)
    const conflict = await m.api.setPcSaveFolder('manual:hk', 'D:\\conflict')
    expect(conflict.conflict?.cloudDevice).toBe('LIVING-ROOM')
    expect(m.blocksLaunch('manual:hk')).toBe(true)
    expect((await m.api.resolvePcSaveConflict('manual:hk', 'local')).conflict).toBeNull()
    expect((await m.api.setPcSaveFolder('manual:hk', 'D:\\other')).confirm?.machine).toBe(
      'LIVING-ROOM'
    )
    expect((await m.api.answerPcSaveCopy('manual:hk', true)).copyMachine).toBe('LIVING-ROOM')
    expect((await m.api.setPcSaveFolder('manual:hk', null)).folder).toBeNull()
  })
})
