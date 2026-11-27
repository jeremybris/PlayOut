import type { RetroAchievementsStatus, Settings } from '@shared/types'
import { ExternalLink, LogOut, RefreshCw, Trophy } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Chip } from '../../components/Chip'
import { useT, type Translate } from '../../i18n'
import { setFocus, type Direction } from '../../input/focus'
import {
  announce,
  announceNextRetroAnswer,
  claimRetroAnswer,
  retroSignedIn,
  useRetroAchievementsStatus
} from '../../state/retroachievements'
import { useUiStore } from '../../state/ui'
import { fk, log, useDebouncedPatch } from './common'
import { SecretField } from './SecretField'

const SECTION = 'emulators'
const KEY_URL = 'https://retroachievements.org/settings'
const LINK_KEY = fk(SECTION, 'ra:link')
const SIGN_OUT_KEY = fk(SECTION, 'ra:signout')
type Credentials = Settings['scrapers']['retroachievements']

const trimmed = (c: Credentials): string => `${c.username.trim().toLowerCase()}
${c.apiKey.trim()}`

function describe(status: RetroAchievementsStatus | null, t: Translate): string {
  if (!status) return t('settings.retroAchievements.checking')
  switch (status.state) {
    case 'signed-out':
      return t('settings.retroAchievements.signedOut')
    case 'checking':
      return status.user
        ? t('settings.retroAchievements.syncing', { user: status.user })
        : t('settings.retroAchievements.checking')
    case 'invalid':
    case 'error':
      return status.message ?? t('settings.retroAchievements.notSignedIn')
    case 'signed-in': {
      const parts = [t('settings.retroAchievements.signedInAs', { user: status.user ?? '' })]
      if (status.points !== undefined)
        parts.push(
          t('settings.retroAchievements.points', { points: status.points.toLocaleString() })
        )
      if (status.roms !== undefined)
        parts.push(
          t('settings.retroAchievements.recognised', {
            matched: status.matched ?? 0,
            count: status.roms
          })
        )
      // The status message is main's own sentence (main translates it): appended after the facts.
      return parts.join(' · ') + (status.message ? `. ${status.message}` : '')
    }
  }
}

/**
 * RetroAchievements sign-in for Settings > Emulators: username + Web API key, the account's state, Sync now and
 * Sign out. The main process checks the account once the typing settles and syncs every ROM's counts; the
 * answer to an edit shows as a notification (state/retroachievements.ts), like the key checks in Settings >
 * Metadata, even when the section has closed by then.
 */
export function RetroAchievementsAccount({
  credentials
}: {
  credentials: Credentials
}): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const debounced = useDebouncedPatch()
  const status = useRetroAchievementsStatus()
  // One draft for both fields, so two edits inside the debounce window both survive. Adopted by value: another
  // section's save hands back an equal but new object, which must not undo a field typed a moment ago.
  const { username, apiKey } = credentials
  const draft = useRef(credentials)
  useEffect(() => {
    draft.current = { username, apiKey }
  }, [username, apiKey])
  const [syncing, setSyncing] = useState(false)

  const edit = useCallback(
    (value: Partial<Credentials>) => {
      const before = trimmed(draft.current)
      const next = { ...draft.current, ...value }
      draft.current = next
      // Only a change the main process will see (it compares trimmed values) gets an answer to announce.
      if (trimmed(next) !== before && next.username.trim() !== '' && next.apiKey.trim() !== '')
        announceNextRetroAnswer()
      debounced({ scrapers: { retroachievements: next } })
    },
    [debounced]
  )

  const openKeyPage = (): void => {
    api.openExternal(KEY_URL).catch((err) => {
      log.error('openExternal failed', err)
      toast(t('settings.retroAchievements.openLinkFailed'), 'error')
    })
  }

  const syncNow = (): void => {
    setSyncing(true)
    claimRetroAnswer()
    api
      .syncRetroAchievements()
      .then((result) => {
        if (result.state === 'signed-in' && !result.message)
          toast(
            t('settings.retroAchievements.synced', {
              matched: result.matched ?? 0,
              count: result.roms ?? 0
            }),
            'success'
          )
        else announce(result)
      })
      .catch((err) => {
        log.error('syncRetroAchievements failed', err)
        toast(t('settings.retroAchievements.syncFailed'), 'error')
      })
      .finally(() => setSyncing(false))
  }

  const signOut = (): void => {
    const empty = { username: '', apiKey: '' }
    draft.current = empty
    debounced({ scrapers: { retroachievements: empty } })
    toast(t('settings.retroAchievements.signedOutToast'), 'info')
  }

  const signedIn = retroSignedIn(status)
  const hasCredentials = username.trim() !== '' || apiKey.trim() !== ''
  // Up from a field: the account row's Sign out when it can take focus, else the narrow key link, which the focus
  // engine would not find on its own.
  const upFromField = (direction: Direction): boolean => {
    if (direction !== 'up') return true
    void setFocus(hasCredentials ? SIGN_OUT_KEY : LINK_KEY)
    return false
  }

  return (
    <div className="section">
      <div className="credential-title">
        <div className="section__title">RetroAchievements</div>
        <Button
          focusKey={LINK_KEY}
          variant="ghost"
          iconRight={<ExternalLink />}
          onPress={openKeyPage}
          aria-label={t('settings.retroAchievements.keyLinkLabel')}
        >
          {t('settings.retroAchievements.keyLink')}
        </Button>
      </div>
      <p className="settings-note">{t('settings.retroAchievements.note')}</p>
      <div className="settings-card">
        <div className="settings-row">
          {signedIn && status?.avatar ? (
            <img className="ra-account__avatar" src={status.avatar} alt="" />
          ) : (
            <span className="control__icon">
              <Trophy />
            </span>
          )}
          <div className="settings-row__text">
            <span className="settings-row__label">
              {t('settings.retroAchievements.account')}
              {signedIn ? (
                <Chip accent className="settings-row__chip">
                  {t('settings.retroAchievements.signedIn')}
                </Chip>
              ) : status?.state === 'invalid' ? (
                <Chip className="settings-row__chip settings-row__chip--warn">
                  {t('settings.retroAchievements.notWorking')}
                </Chip>
              ) : null}
            </span>
            <span className="settings-row__value" aria-live="polite">
              {describe(status, t)}
            </span>
          </div>
          <div className="settings-row__actions">
            <Button
              focusKey={fk(SECTION, 'ra:sync')}
              icon={<RefreshCw />}
              disabled={!signedIn || syncing || status?.state === 'checking'}
              onPress={syncNow}
            >
              {t('settings.retroAchievements.syncNow')}
            </Button>
            <Button
              focusKey={SIGN_OUT_KEY}
              variant="ghost"
              icon={<LogOut />}
              disabled={!hasCredentials}
              onPress={signOut}
            >
              {t('settings.retroAchievements.signOut')}
            </Button>
          </div>
        </div>
      </div>
      <div className="settings-grid">
        <SecretField
          focusKey={fk(SECTION, 'ra:user')}
          onArrowPress={upFromField}
          label={t('settings.retroAchievements.username')}
          plain
          value={credentials.username}
          onChange={(username) => edit({ username })}
        />
        <SecretField
          focusKey={fk(SECTION, 'ra:key')}
          onArrowPress={upFromField}
          label={t('settings.retroAchievements.apiKey')}
          value={credentials.apiKey}
          onChange={(apiKey) => edit({ apiKey })}
        />
      </div>
    </div>
  )
}
