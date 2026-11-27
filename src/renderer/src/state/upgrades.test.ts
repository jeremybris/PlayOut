import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpgradeProgress } from '@shared/upgrades'
import { describe, expect, it, vi } from 'vitest'

// Capture the module's listener so the test can play main's events.
const { listeners, api } = vi.hoisted(() => {
  const listeners = new Map<string, (payload: unknown) => void>()
  const api = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    })
  }
  return { listeners, api }
})
vi.mock('../api/client', () => ({ api }))

const { startUpgradeProgress } = await import('./upgrades')
const { useUiStore } = await import('./ui')

const progress = (p: Partial<UpgradeProgress>): UpgradeProgress => ({
  gameId: 'steam:620',
  upgrade: 'compress',
  state: 'running',
  progress: null,
  message: '',
  ...p
})

describe('upgrade toasts', () => {
  it('toast an automatic compress that ends, with no Upgrade menu ever opened', () => {
    startUpgradeProgress()
    listeners.get('upgrades:progress')!(
      progress({ state: 'done', progress: 1, message: 'Portal 2 compressed: 10 GB → 6 GB' })
    )
    listeners.get('upgrades:progress')!(
      progress({ state: 'failed', message: 'Some files could not be compressed.' })
    )
    expect(useUiStore.getState().toasts.map((t) => `${t.kind}:${t.text}`)).toEqual([
      'success:Portal 2 compressed: 10 GB → 6 GB',
      'error:Some files could not be compressed.'
    ])
  })

  it('the app starts listening when it starts, not when an Upgrade menu opens', () => {
    const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8')
    expect(app).toMatch(/startUpgradeProgress\(\)/)
  })
})
