import type { AccountStatus } from '@shared/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The module subscribes at import time: capture its listener so the tests can play main's events.
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

const { importEndToast, useAccountsStore } = await import('./accounts')
const { useUiStore } = await import('./ui')

const OUTAGE =
  "Steam's servers are not responding right now (HTTP 502 Bad Gateway). This is a problem on Steam's side, not in PlayOut. Your Steam games are unchanged; PlayOut will try again in 10 minutes."

function row(over: Partial<AccountStatus>): AccountStatus {
  return { source: 'steam', supported: true, signedIn: true, importing: false, ...over }
}

beforeEach(() => {
  useAccountsStore.setState({ accounts: [], loaded: false })
  useUiStore.setState({ toasts: [] })
})

describe('importEndToast', () => {
  it('shows a store-side failure as a warning in its own words', () => {
    expect(importEndToast(row({ error: OUTAGE, errorKind: 'store' }))).toEqual({
      text: OUTAGE,
      kind: 'warning',
      durationMs: 10_000
    })
  })

  it('keeps "import failed" errors for everything else', () => {
    expect(importEndToast(row({ error: 'Import failed: invalid JSON from x' }))).toEqual({
      text: 'Steam import failed: Import failed: invalid JSON from x',
      kind: 'error'
    })
    expect(importEndToast(row({}))).toBeNull()
  })
})

describe('accounts:changed', () => {
  it('raises the outage notice once the import ends', () => {
    const emit = listeners.get('accounts:changed')!
    emit([row({ importing: true })])
    emit([row({ error: OUTAGE, errorKind: 'store' })])
    const toasts = useUiStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ text: OUTAGE, kind: 'warning' })
    expect(toasts[0].text).not.toMatch(/import failed/i)
  })
})
