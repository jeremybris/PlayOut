import type { PcSaveView } from '@shared/pc-saves'
import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage, t } from '../i18n'
import { pcSaveConflictText, pcSaveStatus } from './pcSaves'

const view = (patch: Partial<PcSaveView> = {}): PcSaveView => ({
  gameId: 'manual:a',
  featureOn: true,
  folder: 'C:\\Users\\me\\AppData\\LocalLow\\Team Cherry\\Hollow Knight',
  copyDir: null,
  syncedAt: null,
  copyMachine: null,
  pending: false,
  error: null,
  conflict: null,
  confirm: null,
  running: false,
  ...patch
})

afterEach(() => setLanguage('en'))

describe('pcSaveStatus', () => {
  it('says nothing without a folder, and each state in turn', () => {
    expect(pcSaveStatus(view({ folder: null }), t, 'HK')).toBeNull()
    expect(pcSaveStatus(view(), t, 'HK')?.text).toBe('Not copied yet.')
    expect(pcSaveStatus(view({ featureOn: false }), t, 'HK')?.text).toMatch(/Settings › Library/)
    expect(pcSaveStatus(view({ pending: true }), t, 'HK')?.text).toBe('Waiting to be copied.')
    expect(pcSaveStatus(view({ error: 'locked' }), t, 'HK')).toEqual({
      text: 'Could not copy: locked',
      tone: 'warn'
    })
    expect(pcSaveStatus(view({ running: true, error: 'x' }), t, 'HK')?.text).toMatch(/running/)
    expect(
      pcSaveStatus(view({ syncedAt: '2026-11-20T10:00:00Z', copyMachine: 'DESK' }), t, 'HK')?.text
    ).toMatch(/DESK/)
    const conflict = {
      localAt: '2026-11-20T10:00:00Z',
      cloudAt: '2026-11-21T10:00:00Z',
      cloudDevice: 'DESK'
    }
    expect(pcSaveStatus(view({ conflict }), t, 'HK')?.tone).toBe('warn')
    expect(pcSaveStatus(view({ confirm: { machine: 'DESK', title: '' } }), t, 'HK')?.text).toMatch(
      /DESK copied for a game with the same name \(HK\)/
    )
  })

  it('tells the two sides of a conflict, in Spanish too', () => {
    const conflict = {
      localAt: '2026-11-20T10:00:00Z',
      cloudAt: '2026-11-21T10:00:00Z',
      cloudDevice: 'DESK'
    }
    expect(pcSaveConflictText(conflict, t)).toMatch(/from DESK/)
    setLanguage('es')
    expect(pcSaveConflictText(conflict, t)).toMatch(/desde DESK/)
  })
})
