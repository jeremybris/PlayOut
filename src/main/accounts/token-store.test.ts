import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { silentLog } from './test-helpers'
import { normalizeAccountsFile, TokenStore, type TokenCrypto } from './token-store'

/** A reversible stand-in for DPAPI: base64 of the reversed text, prefixed so a foreign blob is recognisable. */
function fakeCrypto(options: { available?: boolean; failDecrypt?: boolean } = {}): TokenCrypto {
  return {
    isEncryptionAvailable: () => options.available ?? true,
    encryptString: (text) => Buffer.from(`enc:${[...text].reverse().join('')}`),
    decryptString: (buffer) => {
      const text = buffer.toString()
      if (options.failDecrypt || !text.startsWith('enc:')) throw new Error('decryption failed')
      return [...text.slice(4)].reverse().join('')
    }
  }
}

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-tokens-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('TokenStore', () => {
  it('round-trips encrypted tokens through accounts.json and never stores them in clear', async () => {
    const file = join(dir, 'accounts.json')
    const store = new TokenStore(file, silentLog, fakeCrypto())
    await store.load()
    expect(await store.get('steam')).toBeNull()
    await store.set('steam', { kind: 'web', steamId64: '1', webapiToken: 'secret-token' })
    store.setMeta('steam', {
      displayName: 'example_user',
      lastImportAt: '2026-11-01T00:00:00.000Z',
      lastImportCount: 12
    })
    await store.flush()
    const raw = await fs.readFile(file, 'utf8')
    expect(raw).not.toContain('secret-token')
    expect(JSON.parse(raw).accounts.steam.encrypted).toBeTypeOf('string')

    const reopened = new TokenStore(file, silentLog, fakeCrypto())
    await reopened.load()
    expect(await reopened.get('steam')).toEqual({
      kind: 'web',
      steamId64: '1',
      webapiToken: 'secret-token'
    })
    expect(reopened.meta('steam')).toEqual({
      displayName: 'example_user',
      lastImportAt: '2026-11-01T00:00:00.000Z',
      lastImportCount: 12
    })
    expect(reopened.has('steam')).toBe(true)
    expect(reopened.has('epic')).toBe(false)
  })

  it('treats a blob that does not decrypt as signed out', async () => {
    const file = join(dir, 'accounts.json')
    const store = new TokenStore(file, silentLog, fakeCrypto())
    await store.load()
    await store.set('gog', { kind: 'oauth', accessToken: 'a' })
    await store.flush()
    const other = new TokenStore(file, silentLog, fakeCrypto({ failDecrypt: true }))
    await other.load()
    expect(await other.get('gog')).toBeNull()
    expect(other.has('gog')).toBe(true)
  })

  it('falls back to plain JSON when encryption is unavailable', async () => {
    const file = join(dir, 'accounts.json')
    const store = new TokenStore(file, silentLog, fakeCrypto({ available: false }))
    await store.load()
    await store.set('epic', { kind: 'oauth', accessToken: 'a' })
    await store.flush()
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(parsed.accounts.epic.plain).toEqual({ kind: 'oauth', accessToken: 'a' })
    expect(parsed.accounts.epic.encrypted).toBeUndefined()
    const reopened = new TokenStore(file, silentLog, fakeCrypto({ available: false }))
    await reopened.load()
    expect(await reopened.get('epic')).toEqual({ kind: 'oauth', accessToken: 'a' })
  })

  it('deletes an account entirely', async () => {
    const store = new TokenStore(join(dir, 'accounts.json'), silentLog, fakeCrypto())
    await store.load()
    await store.set('xbox', { kind: 'msa', xid: '1' })
    store.setMeta('xbox', { lastImportCount: 3 })
    store.delete('xbox')
    expect(await store.get('xbox')).toBeNull()
    expect(store.meta('xbox')).toEqual({})
  })

  it('normalizes a hand-edited file', () => {
    expect(normalizeAccountsFile(null)).toBeNull()
    expect(
      normalizeAccountsFile({
        accounts: { steam: { encrypted: 'abc', lastImportCount: 'x' }, bogus: 5 }
      })
    ).toEqual({
      version: 1,
      accounts: { steam: { encrypted: 'abc' } }
    })
  })
})
