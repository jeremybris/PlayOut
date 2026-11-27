import type { AccountStatus } from '@shared/types'
import { t } from '../i18n'
import { daysSince, formatDate } from './format'

/**
 * A store account's status line on its Library Import (Add Games) card: "Signed in as … · N games · imported
 * today", "Not signed in", "Installed games only — <reason>", or that the sign-in window is open.
 */
export function accountStatusText({
  name,
  account,
  pending
}: {
  name: string
  account: AccountStatus | undefined
  pending: boolean
}): string {
  if (pending) return t('lib.account.finishSignIn')
  if (!account) return t('lib.account.checking')
  if (!account.supported)
    return account.reason
      ? t('lib.account.installedOnly', { reason: account.reason })
      : t('lib.account.installedOnlyNoSignIn', { store: name })
  if (!account.signedIn) return t('lib.account.notSignedIn')
  const parts = [
    account.displayName
      ? t('lib.account.signedInAs', { name: account.displayName })
      : t('lib.account.signedInAsYou')
  ]
  if (account.importing) parts.push(t('lib.account.importing'))
  else {
    if (account.lastImportCount !== undefined)
      parts.push(t('lib.account.games', { count: account.lastImportCount }))
    if (account.lastImportAt) parts.push(importedText(account.lastImportAt))
  }
  return parts.join(' · ')
}

/** "imported today", "imported yesterday", "imported 3 days ago", else "imported" and the date. */
function importedText(at: string): string {
  const days = daysSince(at)
  if (days === null) return t('lib.account.importedOn', { date: '' })
  if (days <= 0) return t('lib.account.importedToday')
  if (days === 1) return t('lib.account.importedYesterday')
  if (days < 7) return t('lib.account.importedDaysAgo', { count: days })
  return t('lib.account.importedOn', { date: formatDate(at, 'short') })
}
