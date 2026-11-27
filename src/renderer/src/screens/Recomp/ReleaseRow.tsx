// One release of a recompilation: tag, name, date, size, pre-release / current chips, expandable notes and one
// action. Shared by the Recompilation page's Releases list and Settings › Recompilations' Change version list.
import type { RecompRelease } from '@shared/recomp'
import { ChevronDown, Download } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { Button } from '../../components/Button'
import { Chip } from '../../components/Chip'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import { formatBytes, formatDate } from '../../lib/format'
import { Markdown } from './Markdown'
import './recomp.css'

export interface ReleaseRowProps {
  release: RecompRelease
  /** The release in use (outlined, with `currentLabel`; no action). */
  current: boolean
  /** The current release's chip ('Installed', 'In use'). */
  currentLabel?: string
  /** An extra chip after it ('Pinned' for a pinned version). */
  currentNote?: string | null
  /** Why a release without a Windows file cannot be installed (default 'No Windows download'). */
  unavailable?: string | null
  actionLabel: string
  actionIcon?: ReactElement
  busy: boolean
  onAction: () => void
  repoUrl: string
  focusKeys: { notes: string; action: string }
}

export function ReleaseRow({
  release,
  current,
  currentLabel,
  currentNote = null,
  unavailable: reason = null,
  actionLabel,
  actionIcon,
  busy,
  onAction,
  repoUrl,
  focusKeys
}: ReleaseRowProps): ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const notes = release.notes.trim()
  const date = formatDate(release.publishedAt, 'medium')
  // A release with no Windows file cannot be installed: it is shown dimmed, with the reason.
  const unavailable = !release.asset
  return (
    <div
      className={cx(
        'recomp-release',
        current && 'recomp-release--current',
        unavailable && !current && 'recomp-release--unavailable'
      )}
    >
      <div className="recomp-release__head">
        <div className="recomp-release__text">
          <span className="recomp-release__tag">
            {release.tag}
            {release.name && release.name !== release.tag ? (
              <span className="recomp-release__name"> · {release.name}</span>
            ) : null}
          </span>
          <span className="recomp-release__meta">
            {[
              date,
              release.asset
                ? formatBytes(release.asset.size)
                : (reason ?? t('recomp.releases.noWindowsDownload'))
            ]
              .filter(Boolean)
              .join(' · ')}
            {release.prerelease ? <Chip>{t('recomp.releases.prerelease')}</Chip> : null}
            {current ? <Chip accent>{currentLabel ?? t('recomp.releases.installed')}</Chip> : null}
            {current && currentNote ? <Chip>{currentNote}</Chip> : null}
          </span>
        </div>
        <div className="recomp-release__actions">
          {notes ? (
            <Button
              focusKey={focusKeys.notes}
              variant="ghost"
              iconRight={
                <ChevronDown className={cx('recomp__chevron', open && 'recomp__chevron--open')} />
              }
              onPress={() => setOpen((o) => !o)}
            >
              {open ? t('recomp.releases.hideNotes') : t('recomp.releases.notes')}
            </Button>
          ) : null}
          {!current && release.asset ? (
            <Button
              focusKey={focusKeys.action}
              icon={actionIcon ?? <Download />}
              disabled={busy}
              onPress={onAction}
            >
              {actionLabel}
            </Button>
          ) : null}
        </div>
      </div>
      {open && notes ? (
        <Markdown className="recomp-release__notes" text={notes} baseUrl={repoUrl} />
      ) : null}
    </div>
  )
}
