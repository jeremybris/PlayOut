import type { AccountStatus } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { accountStatusText } from './accountStatus'

const account = (patch: Partial<AccountStatus>): AccountStatus =>
  ({ source: 'epic', supported: true, signedIn: false, ...patch }) as AccountStatus

describe('accountStatusText', () => {
  it('says what the account on a Library Import card is', () => {
    expect(accountStatusText({ name: 'Epic Games', account: undefined, pending: false })).toBe(
      'Checking your account…'
    )
    expect(accountStatusText({ name: 'Epic Games', account: account({}), pending: false })).toBe(
      'Not signed in'
    )
    expect(accountStatusText({ name: 'Epic Games', account: account({}), pending: true })).toBe(
      'Finish signing in in the window that opened…'
    )
    expect(
      accountStatusText({
        name: 'Epic Games',
        account: account({ signedIn: true, displayName: 'Jeremy', lastImportCount: 3 }),
        pending: false
      })
    ).toBe('Signed in as Jeremy · 3 games')
    expect(
      accountStatusText({
        name: 'Epic Games',
        account: account({ signedIn: true, displayName: 'Jeremy', importing: true }),
        pending: false
      })
    ).toBe('Signed in as Jeremy · importing your library…')
    expect(
      accountStatusText({
        name: 'Ubisoft Connect',
        account: account({ supported: false, reason: 'no sign-in' }),
        pending: false
      })
    ).toBe('Installed games only — no sign-in')
  })
})
