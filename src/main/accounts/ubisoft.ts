// Ubisoft Connect: no account import in this release (the only owned-games endpoint rejects the public app id,
// docs/research/store-accounts.md §7). Installed games still come from the client, and an uninstalled record that
// another path created can be handed to `uplay://install/<id>`.
import type { ClientInfo, Game } from '../../shared/types'
import type { InstallSpec, StoreAccount } from './types'
import { tMain } from '../i18n'

export const ubisoftReason = (): string => tMain('mainAccounts.ubisoft.noSignIn')

export function createUbisoftAccount(): StoreAccount {
  return {
    source: 'ubisoft',
    storeName: 'Ubisoft Connect',
    supported: false,
    get reason() {
      return ubisoftReason()
    },
    get confirmMessage() {
      return tMain('mainAccounts.confirm.ubisoft')
    },
    async signIn() {
      return null
    },
    async refresh() {
      return null
    },
    async displayName() {
      return undefined
    },
    async fetchOwned() {
      return []
    },
    installSpec(game: Game, client: ClientInfo): InstallSpec | null {
      if (!client.installed) return null
      const id = String(game.extra?.ubisoftId ?? game.externalId).trim()
      return /^\d+$/.test(id) ? { kind: 'uri', uri: `uplay://install/${id}` } : null
    },
    installError(_game, client) {
      return client.installed
        ? tMain('mainAccounts.install.ubisoftNoId')
        : tMain('mainAccounts.install.ubisoftMissing')
    }
  }
}

export const ubisoftAccount = createUbisoftAccount()
