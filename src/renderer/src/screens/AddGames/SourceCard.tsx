import type { AccountStatus, Platform, ScanProgress, SourceStatus } from '@shared/types'
import { ExternalLink, LogIn, LogOut, RefreshCw } from 'lucide-react'
import type { ReactElement } from 'react'
import { Button } from '../../components/Button'
import { PlatformBadge } from '../../components/PlatformBadge'
import { Spinner } from '../../components/Spinner'
import { useT, type Translate } from '../../i18n'
import { cx } from '../../lib/cx'
import { accountStatusText } from '../../lib/accountStatus'
import { formatRelativeDay } from '../../lib/format'
import { accountFocusKey } from './keys'

export interface SourceCardProps {
  source: SourceStatus
  /** Platform row for the badge (falls back to the source id's glyph). */
  platform?: Platform
  /** Latest 'scan:progress' event for this source while a scan runs. */
  progress?: ScanProgress
  /** This source is being scanned right now. */
  scanning: boolean
  /** Last error from scanning this source (shown inline under the status). */
  error?: string
  onScan: () => void
  /** Open the store client's download page (shown instead of Scan when the client is missing). */
  onInstall: () => void
  /**
   * The store's account (ARCHITECTURE.md §6.1): its status line and a Sign in or Sign out button on the card.
   * Undefined for a store PlayOut has no account support for, or while the account list loads.
   */
  account?: AccountStatus
  /** The sign-in window for this store is open. */
  signingIn?: boolean
  onSignIn?: () => void
  onSignOut?: () => void
}

/** Live status text for a scan in flight. */
function progressText(progress: ScanProgress, t: Translate): string {
  const found = progress.found
  switch (progress.phase) {
    case 'detecting':
      return t('addGames.source.detectingClient')
    case 'scanning':
      return progress.message
        ? t('addGames.source.foundWithMessage', { found, message: progress.message })
        : t('addGames.source.foundRunning', { found })
    case 'done':
      return progress.message ?? t('addGames.source.found', { found })
    case 'error':
      return progress.message ?? t('addGames.source.scanFailed')
  }
}

/** The live "N found · Title" line shown on a card while its scan runs. */
export function ScanLiveText({
  progress
}: {
  progress: ScanProgress | undefined
}): ReactElement | null {
  const t = useT()
  return (
    <span
      className={cx('srccard__live', progress?.phase === 'error' && 'srccard__live--error')}
      aria-live="polite"
    >
      {progress ? progressText(progress, t) : t('addGames.source.startingScan')}
    </span>
  )
}

/**
 * One store in the Add Games grid: badge, name and detection status with the Scan button (or an
 * Install link when the client is missing) in the head row; client path, game count and last scan
 * below. Scan progress streams in through `progress`.
 */
export function SourceCard({
  source,
  platform,
  progress,
  scanning,
  error,
  onScan,
  onInstall,
  account,
  signingIn = false,
  onSignIn,
  onSignOut
}: SourceCardProps): ReactElement {
  const t = useT()
  const installed = source.client.installed
  const lastScan = source.lastScanAt ? formatRelativeDay(source.lastScanAt) : null
  const summary = [
    source.gameCount > 0 ? t('addGames.games', { count: source.gameCount }) : null,
    lastScan
      ? t('addGames.source.lastScan', { when: lastScan.toLowerCase() })
      : t('addGames.source.notScanned'),
    source.enabled ? null : t('addGames.source.disabled')
  ]
    .filter(Boolean)
    .join(' · ')
  const clientText =
    (source.client.path ?? t('addGames.source.clientDetected')) +
    (source.client.version ? ` · v${source.client.version}` : '')

  return (
    <article
      className={cx('srccard', !installed && 'srccard--missing', scanning && 'srccard--scanning')}
      aria-label={source.name}
      aria-busy={scanning || undefined}
    >
      <header className="srccard__head">
        <PlatformBadge
          platform={platform}
          icon={platform ? undefined : source.id}
          name={source.name}
          size="lg"
        />
        <div className="srccard__titles">
          <span className="srccard__name">{source.name}</span>
          <span className={cx('srccard__status', installed && 'srccard__status--ok')}>
            {installed ? t('addGames.source.detected') : t('addGames.source.notInstalled')}
          </span>
        </div>
        {installed ? (
          <Button
            focusKey={`addgames:scan:${source.id}`}
            icon={scanning ? <Spinner size="sm" /> : <RefreshCw />}
            onPress={onScan}
            aria-label={t('addGames.source.scanLabel', { name: source.name })}
            className="srccard__action"
          >
            {scanning ? t('addGames.source.scanning') : t('addGames.source.scan')}
          </Button>
        ) : (
          <Button
            focusKey={`addgames:install:${source.id}`}
            icon={<ExternalLink />}
            onPress={onInstall}
            aria-label={t('addGames.source.downloadLabel', { name: source.name })}
            className="srccard__action"
          >
            {t('addGames.source.get', { name: source.name })}
          </Button>
        )}
      </header>
      <div className="srccard__info">
        {installed ? (
          // One line: the games and last scan, then the client (its full path is the tooltip), so the card has room
          // for its account line and the store, ROM and PC cards fit the modal without scrolling.
          scanning ? (
            <ScanLiveText progress={progress} />
          ) : (
            <span className="srccard__path" title={clientText}>
              {capitalize(summary)} · {clientText}
            </span>
          )
        ) : (
          <span>{t('addGames.source.installHint', { name: source.name })}</span>
        )}
        {error ? <span className="srccard__error">{error}</span> : null}
        {!error && source.error && !scanning ? (
          <span className="srccard__error">
            {t('addGames.source.lastScanError', { error: source.error })}
          </span>
        ) : null}
      </div>
      {account ? (
        <AccountRow
          sourceId={source.id}
          name={source.name}
          account={account}
          signingIn={signingIn}
          onSignIn={onSignIn}
          onSignOut={onSignOut}
        />
      ) : null}
    </article>
  )
}

/**
 * The card's account line: what the account is (signed in as …, not signed in, installed games only) and its Sign in
 * or Sign out button. Signing in imports the games the account owns (they show greyed out until installed), and
 * every scan of the store imports them again, so there is no separate import button. An account signed in through
 * Settings > Metadata (Steam's Web API key) has no Sign out: the line says where the key lives.
 */
function AccountRow({
  sourceId,
  name,
  account,
  signingIn,
  onSignIn,
  onSignOut
}: {
  sourceId: string
  name: string
  account: AccountStatus
  signingIn: boolean
  onSignIn?: () => void
  onSignOut?: () => void
}): ReactElement {
  const t = useT()
  const signedIn = account.supported && account.signedIn
  const status = accountStatusText({ name, account, pending: signingIn })
  return (
    <div className={cx('srccard__account', !account.supported && 'srccard__account--none')}>
      <span
        className={cx('srccard__account-status', signedIn && 'srccard__status--ok')}
        title={status}
        aria-live="polite"
      >
        {status}
      </span>
      {account.error && !signingIn ? (
        <span
          className={cx(
            'srccard__error',
            account.errorKind === 'store' && 'srccard__error--notice'
          )}
        >
          {account.error}
        </span>
      ) : null}
      {!account.supported ? null : signedIn ? (
        account.viaSettings ? (
          <span className="srccard__account-hint">{t('addGames.source.keyInSettings')}</span>
        ) : (
          <Button
            focusKey={accountFocusKey(sourceId, 'signout')}
            icon={<LogOut />}
            disabled={account.importing}
            onPress={onSignOut}
            className="srccard__account-btn"
            aria-label={t('addGames.source.signOutLabel', { name })}
          >
            {t('addGames.source.signOut')}
          </Button>
        )
      ) : (
        <Button
          focusKey={accountFocusKey(sourceId, 'signin')}
          variant="primary"
          icon={signingIn ? <Spinner size="sm" /> : <LogIn />}
          disabled={signingIn}
          onPress={onSignIn}
          className="srccard__account-btn"
          aria-label={t('addGames.source.signInLabel', { name })}
        >
          {signingIn ? t('addGames.source.signingIn') : t('addGames.source.signIn')}
        </Button>
      )}
    </div>
  )
}

function capitalize(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text
}
