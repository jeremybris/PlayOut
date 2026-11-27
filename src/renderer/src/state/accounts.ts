import { STORE_PLATFORMS } from '@shared/platforms'
import type { AccountStatus, StoreSourceId } from '@shared/types'
import { create } from 'zustand'
import { api } from '../api/client'
import { t } from '../i18n'
import { createLog } from '../lib/log'
import { useUiStore } from './ui'

const log = createLog('accounts')

/**
 * Store accounts (ARCHITECTURE.md §4.8): the account line per store shown on the Library Import (Add Games) cards. Fed
 * by getAccounts() on first use and by 'accounts:changed' afterwards. Sign-in, sign-out and import go
 * through here so every screen sees the same pending state ("Finish signing in in the window that opened…").
 */
export interface AccountsState {
  /** In STORE_SOURCES order; empty until the first refresh resolved. */
  accounts: AccountStatus[]
  loaded: boolean
  error?: string
  /** The store whose sign-in window is open right now (one at a time). */
  pendingSignIn: StoreSourceId | null
  refresh(): Promise<void>
  /** Open the store's sign-in window; resolves when it closes. Errors are logged and toasted. */
  signIn(source: StoreSourceId): Promise<void>
  signOut(source: StoreSourceId): Promise<void>
  /** Re-import the owned library of one signed-in store (the result arrives through 'accounts:changed'). */
  importOwned(source: StoreSourceId): Promise<void>
}

export const useAccountsStore = create<AccountsState>()((set, get) => ({
  accounts: [],
  loaded: false,
  pendingSignIn: null,
  async refresh() {
    try {
      const accounts = await api.getAccounts()
      set({ accounts, loaded: true, error: undefined })
    } catch (err) {
      log.error('getAccounts failed', err)
      set({ loaded: true, error: String(err) })
    }
  },
  async signIn(source) {
    if (get().pendingSignIn) return
    set({ pendingSignIn: source })
    try {
      const status = await api.signIn(source)
      if (status.signedIn)
        useUiStore.getState().toast(
          status.displayName
            ? t('state.accounts.signedInAs', {
                store: storeName(source),
                name: status.displayName
              })
            : t('state.accounts.signedIn', { store: storeName(source) }),
          'success'
        )
    } catch (err) {
      log.error(`signIn(${source}) failed`, err)
      useUiStore
        .getState()
        .toast(
          t('state.accounts.signInFailed', { store: storeName(source), error: message(err) }),
          'error'
        )
    } finally {
      set({ pendingSignIn: null })
    }
  },
  async signOut(source) {
    try {
      await api.signOut(source)
      useUiStore.getState().toast(t('state.accounts.signedOut', { store: storeName(source) }))
    } catch (err) {
      log.error(`signOut(${source}) failed`, err)
      useUiStore
        .getState()
        .toast(
          t('state.accounts.signOutFailed', { store: storeName(source), error: message(err) }),
          'error'
        )
    }
  },
  async importOwned(source) {
    try {
      const result = await api.importOwned([source])
      // A failure toast comes from the importing -> idle transition below (sign-in imports too); success is silent.
      const failed = result.sources.find((s) => s.id === source && s.error)
      if (failed) log.warn(`import of ${source} failed: ${failed.error}`)
    } catch (err) {
      log.error(`importOwned(${source}) failed`, err)
      useUiStore
        .getState()
        .toast(
          t('state.accounts.importFailed', { store: storeName(source), error: message(err) }),
          'error'
        )
    }
  }
}))

/** The store's display name ('Epic Games', 'Battle.net'). */
export function storeName(source: StoreSourceId): string {
  return STORE_PLATFORMS[source].name
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Every account list from the main process replaces ours. An import that just ended raises a toast only when it
// failed: the imports at every start (and after each sign-in or scan) would otherwise announce "Imported N games" for
// every store each time; the counts show on the store rows of Library > Settings instead.
api.on('accounts:changed', (accounts) => {
  const previous = new Map(useAccountsStore.getState().accounts.map((a) => [a.source, a]))
  useAccountsStore.setState({ accounts, loaded: true, error: undefined })
  const { toast } = useUiStore.getState()
  for (const account of accounts) {
    const before = previous.get(account.source)
    if (!before?.importing || account.importing) continue
    const notice = importEndToast(account)
    if (notice) toast(notice.text, notice.kind, notice.durationMs)
  }
})

/**
 * The toast for an import that just ended with an error. A store-side problem (its servers are down or limiting
 * requests) is a warning that already names the store and says PlayOut is not at fault; anything else is an
 * "import failed" error.
 */
export function importEndToast(
  account: AccountStatus
): { text: string; kind: 'warning' | 'error'; durationMs?: number } | null {
  if (!account.error) return null
  if (account.errorKind === 'store')
    return { text: account.error, kind: 'warning', durationMs: 10_000 }
  return {
    text: t('state.accounts.importEnded', {
      store: storeName(account.source),
      error: account.error
    }),
    kind: 'error'
  }
}

/** React hook: one store's account status (undefined until loaded). */
export function useAccount(source: StoreSourceId): AccountStatus | undefined {
  return useAccountsStore((s) => s.accounts.find((a) => a.source === source))
}
