// userData/accounts.json: one entry per store with the encrypted credential and the import bookkeeping
// (docs/ARCHITECTURE.md §4.8 "Token store"). safeStorage is usable only after app.whenReady(), so blobs are decrypted
// lazily on first use; a blob that does not decrypt (DPAPI of another Windows user, a corrupt file) means
// "signed out", never an exception.
import type { StoreSourceId } from '../../shared/types'
import type { Logger } from '../logger'
import { JsonStore } from '../store/json-store'
import type { AccountTokens } from './types'

/** The part of Electron's safeStorage the store uses; injected so tests can run without Electron. */
export interface TokenCrypto {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface AccountEntry {
  /** base64 of safeStorage.encryptString(JSON.stringify(tokens)). */
  encrypted?: string
  /** Plain JSON tokens when encryption was unavailable (logged once). */
  plain?: AccountTokens
  displayName?: string
  lastImportAt?: string
  lastImportCount?: number
}

export interface AccountsFile {
  version: 1
  accounts: Partial<Record<StoreSourceId, AccountEntry>>
}

export type AccountMeta = Pick<AccountEntry, 'displayName' | 'lastImportAt' | 'lastImportCount'>

function emptyFile(): AccountsFile {
  return { version: 1, accounts: {} }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeEntry(raw: unknown): AccountEntry | null {
  if (!isObject(raw)) return null
  const entry: AccountEntry = {}
  if (typeof raw.encrypted === 'string' && raw.encrypted) entry.encrypted = raw.encrypted
  if (isObject(raw.plain) && typeof raw.plain.kind === 'string')
    entry.plain = raw.plain as AccountTokens
  if (typeof raw.displayName === 'string' && raw.displayName) entry.displayName = raw.displayName
  if (typeof raw.lastImportAt === 'string' && raw.lastImportAt)
    entry.lastImportAt = raw.lastImportAt
  if (typeof raw.lastImportCount === 'number' && Number.isFinite(raw.lastImportCount))
    entry.lastImportCount = raw.lastImportCount
  return entry
}

/** Turn whatever accounts.json contained into a valid file; unknown sources and malformed entries are dropped. */
export function normalizeAccountsFile(raw: unknown): AccountsFile | null {
  if (!isObject(raw)) return null
  const out = emptyFile()
  if (isObject(raw.accounts)) {
    for (const [source, value] of Object.entries(raw.accounts)) {
      const entry = normalizeEntry(value)
      if (entry) out.accounts[source as StoreSourceId] = entry
    }
  }
  return out
}

async function electronCrypto(): Promise<TokenCrypto> {
  const { safeStorage } = await import('electron')
  return safeStorage
}

export class TokenStore {
  private readonly store: JsonStore<AccountsFile>
  private readonly cache = new Map<StoreSourceId, AccountTokens | null>()
  private crypto: TokenCrypto | null
  private warnedPlain = false

  constructor(
    file: string,
    private readonly log: Logger,
    crypto?: TokenCrypto
  ) {
    this.crypto = crypto ?? null
    this.store = new JsonStore<AccountsFile>({
      file,
      defaults: emptyFile,
      normalize: normalizeAccountsFile
    })
  }

  async load(): Promise<void> {
    await this.store.load()
  }

  private async cryptoApi(): Promise<TokenCrypto> {
    if (!this.crypto) this.crypto = await electronCrypto()
    return this.crypto
  }

  /** The decrypted tokens of a source, or null when none are stored or the blob does not decrypt. */
  async get(source: StoreSourceId): Promise<AccountTokens | null> {
    if (this.cache.has(source)) return this.cache.get(source) ?? null
    const entry = this.store.get().accounts[source]
    let tokens: AccountTokens | null = null
    if (entry?.encrypted) {
      try {
        const text = (await this.cryptoApi()).decryptString(Buffer.from(entry.encrypted, 'base64'))
        const parsed: unknown = JSON.parse(text)
        if (isObject(parsed) && typeof parsed.kind === 'string') tokens = parsed as AccountTokens
        else
          this.log.warn(
            `${source}: stored credential has an unexpected shape; treating as signed out`
          )
      } catch (err) {
        this.log.warn(
          `${source}: stored credential could not be decrypted (${(err as Error).message}); treating as signed out`
        )
      }
    } else if (entry?.plain) {
      tokens = entry.plain
    }
    this.cache.set(source, tokens)
    return tokens
  }

  has(source: StoreSourceId): boolean {
    const entry = this.store.get().accounts[source]
    return !!(entry?.encrypted || entry?.plain)
  }

  async set(source: StoreSourceId, tokens: AccountTokens): Promise<void> {
    const crypto = await this.cryptoApi()
    const text = JSON.stringify(tokens)
    let patch: Pick<AccountEntry, 'encrypted' | 'plain'>
    if (crypto.isEncryptionAvailable()) {
      patch = { encrypted: crypto.encryptString(text).toString('base64'), plain: undefined }
    } else {
      if (!this.warnedPlain) {
        this.warnedPlain = true
        this.log.warn(
          'safeStorage encryption is not available; store credentials are kept as plain JSON in accounts.json'
        )
      }
      patch = { plain: tokens, encrypted: undefined }
    }
    this.store.set((d) => {
      const entry: AccountEntry = { ...(d.accounts[source] ?? {}), ...patch }
      if (!entry.encrypted) delete entry.encrypted
      if (!entry.plain) delete entry.plain
      d.accounts[source] = entry
    })
    this.cache.set(source, tokens)
  }

  /** Forget the credential but keep nothing else either: a signed-out row has no last import. */
  delete(source: StoreSourceId): void {
    this.store.set((d) => {
      delete d.accounts[source]
    })
    this.cache.set(source, null)
  }

  meta(source: StoreSourceId): AccountMeta {
    const entry = this.store.get().accounts[source]
    if (!entry) return {}
    return {
      displayName: entry.displayName,
      lastImportAt: entry.lastImportAt,
      lastImportCount: entry.lastImportCount
    }
  }

  setMeta(source: StoreSourceId, patch: AccountMeta): void {
    this.store.set((d) => {
      const entry: AccountEntry = { ...(d.accounts[source] ?? {}) }
      for (const [key, value] of Object.entries(patch) as [keyof AccountMeta, unknown][]) {
        if (value === undefined) continue
        ;(entry as Record<string, unknown>)[key] = value
      }
      d.accounts[source] = entry
    })
  }

  flush(): Promise<void> {
    return this.store.flush()
  }
}
