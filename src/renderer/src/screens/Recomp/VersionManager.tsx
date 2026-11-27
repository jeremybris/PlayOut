// Managing the version of an installed recompilation: the Version row (the version in use, its label, the pin line,
// Change version) and the project's release list ("Use this version", after a confirmation). One component for the
// Recompilation page and Settings › Recompilations; the release list alone also serves a recompilation that is not
// installed yet (the page's Releases, "Install this one").
import type { InstalledRecomp, RecompRelease, RecompRow } from '@shared/recomp'
import { ChevronDown, ChevronUp, History, RotateCcw, Tag } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Chip } from '../../components/Chip'
import { Spinner } from '../../components/Spinner'
import { useT } from '../../i18n'
import { doesFocusableExist, setFocus } from '../../input/focus'
import { cx } from '../../lib/cx'
import { useUiStore } from '../../state/ui'
import { ReleaseRow } from './ReleaseRow'
import {
  useRecompReleases,
  type Entry,
  type FailHandler,
  type ReleasesState
} from './recompVersions'
import {
  releaseInfo,
  showAllFocus,
  switchConfirm,
  versionActionLabel,
  versionChip,
  versionChipText,
  versionDesc,
  versionItems,
  versionText
} from './versionView'
import './recomp.css'

/** How many releases the list shows before "Show all". */
const VERSIONS_SHOWN = 10

export interface VersionManagerProps {
  /** 'settings': a row of a Settings › Recompilations card; 'page': the Recompilation page's Version section. */
  layout: 'settings' | 'page'
  entry: Entry
  installed: InstalledRecomp
  /** The update waiting for it (none while pinned). */
  update: string | null
  /** What main's last release check knew of the version in use; absent: read from the release list. */
  release?: RecompRow['release']
  /** Read the releases straight away (the label and list ready) rather than on Change version. */
  prefetch?: boolean
  /** An install / update / switch is running: the list's buttons wait. */
  busy: boolean
  /** The focus key of one of its controls ('versions', 'version:<tag>:use', …), unique on its screen. */
  focusKey: (name: string) => string
  /**
   * After a switch starts (the list closes): where focus goes. Absent: Change version (Settings, whose card shows the
   * progress); the Recompilation page sends it to its progress at the top.
   */
  onSwitched?: () => void
  fail: FailHandler
}

const CLASSES = {
  settings: {
    row: 'settings-row settings-recomp-card__control settings-recomp-version',
    text: 'settings-row__text',
    label: 'settings-row__label',
    chip: 'settings-row__chip',
    value: 'settings-row__value',
    desc: 'settings-row__desc',
    actions: 'settings-row__actions',
    list: 'settings-recomp-versions',
    note: 'settings-note'
  },
  page: {
    row: 'recomp-file',
    text: 'recomp-file__text',
    label: 'recomp-file__label',
    chip: undefined,
    value: 'recomp-file__path',
    desc: 'recomp-file__desc',
    actions: 'recomp-file__actions',
    list: 'recomp-vm__list',
    note: 'recomp__lead'
  }
} as const

/**
 * The Version row of an installed recompilation and, under Change version, its releases: "Use this version" asks
 * first (saying when the choice is kept, pinned), then switches through api.setRecompVersion; the install's progress
 * and failure show where the screen shows its installs (the recompilation's progress in the store).
 */
export function VersionManager({
  layout,
  entry,
  installed,
  update,
  release,
  prefetch = false,
  busy,
  focusKey,
  onSwitched,
  fail
}: VersionManagerProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const openModal = useUiStore((s) => s.openModal)
  const [open, setOpen] = useState(false)
  const { releases, retry } = useRecompReleases(entry.id, open || prefetch)
  const c = CLASSES[layout]
  const list = releases.status === 'ready' ? releases.value : null
  const chip = versionChip({
    installed,
    update,
    release: release ?? (list ? releaseInfo(list, installed.tag) : null)
  })

  const useVersion = (target: RecompRelease): void => {
    if (busy) return
    const { title, message } = switchConfirm(entry.name, target)
    openModal({
      type: 'confirm',
      title,
      message,
      confirmLabel: t('recomp.version.switch'),
      onConfirm: () =>
        api
          .setRecompVersion(entry.id, target.tag)
          .then(() => {
            // The list closes and its buttons go: focus moves first (not stranded), to Change version or where the
            // screen shows the progress.
            void setFocus(focusKey('versions'))
            setOpen(false)
            onSwitched?.()
            toast(t('recomp.version.switching', { name: entry.name, tag: target.tag }), 'info')
          })
          .catch(
            fail(
              'setRecompVersion',
              t('recomp.version.switchFailed', { name: entry.name, tag: target.tag })
            )
          )
    })
  }

  return (
    <>
      <div className={cx('recomp-vm', c.row)}>
        {layout === 'settings' ? (
          <span className="control__icon">
            <Tag />
          </span>
        ) : null}
        <div className={c.text}>
          <span className={c.label}>
            {layout === 'settings' ? t('recomp.version.label') : versionText(installed)}
            {chip ? (
              <Chip accent={chip === 'Latest'} className={c.chip}>
                {versionChipText(chip)}
              </Chip>
            ) : null}
            {layout === 'page' && installed.pinnedTag ? (
              <Chip>{t('recomp.version.pinnedTo', { tag: installed.pinnedTag })}</Chip>
            ) : null}
          </span>
          {layout === 'settings' ? <span className={c.value}>{versionText(installed)}</span> : null}
          <span className={c.desc}>{versionDesc(installed)}</span>
        </div>
        <div className={c.actions}>
          <Button
            focusKey={focusKey('versions')}
            icon={<History />}
            iconRight={open ? <ChevronUp /> : <ChevronDown />}
            onPress={() => setOpen((o) => !o)}
            aria-label={
              open
                ? t('recomp.version.hideVersions', { name: entry.name })
                : t('recomp.version.showVersions', { name: entry.name })
            }
          >
            {t('recomp.version.change')}
          </Button>
        </div>
      </div>
      {open ? (
        <ReleaseList
          className={c.list}
          noteClassName={c.note}
          entry={entry}
          installed={installed}
          releases={releases}
          onRetry={retry}
          busy={busy}
          onAction={useVersion}
          focusKey={focusKey}
        />
      ) : null}
    </>
  )
}

export interface ReleaseListProps {
  className?: string
  noteClassName?: string
  entry: Entry
  /** Installed: the one in use is marked and the others offer "Use this version"; else "Install this one". */
  installed: InstalledRecomp | undefined
  releases: ReleasesState
  onRetry: () => void
  busy: boolean
  onAction: (release: RecompRelease) => void
  focusKey: (name: string) => string
}

/**
 * The project's releases, newest first (the first ten, then "Show all"): date, size, pre-release, notes; the one in
 * use marked (pinned or not); releases without a Windows download dimmed, with the reason.
 */
export function ReleaseList({
  className,
  noteClassName,
  entry,
  installed,
  releases,
  onRetry,
  busy,
  onAction,
  focusKey
}: ReleaseListProps): ReactElement {
  const t = useT()
  const [all, setAll] = useState(false)
  const wrap = cx('recomp-vm__list', className)
  if (releases.status === 'error')
    return (
      <div className={wrap}>
        <p className={cx(noteClassName, 'recomp-vm__failed')}>{t('recomp.releases.readFailed')}</p>
        <Button focusKey={focusKey('versions:retry')} icon={<RotateCcw />} onPress={onRetry}>
          {t('recomp.tryAgain')}
        </Button>
      </div>
    )
  if (releases.status === 'loading')
    return (
      <div className={wrap}>
        <Spinner size="sm" label={t('recomp.releases.reading')} />
      </div>
    )
  const items = versionItems(releases.value, installed)
  const shown = all ? items : items.slice(0, VERSIONS_SHOWN)
  return (
    <div className={wrap} aria-label={t('recomp.releases.listLabel', { name: entry.name })}>
      {items.length === 0 ? (
        <p className={noteClassName}>{t('recomp.releases.none')}</p>
      ) : (
        <div className="recomp-releases">
          {shown.map(({ release, inUse, unavailable }) => (
            <ReleaseRow
              key={release.tag}
              release={release}
              current={inUse}
              currentLabel={t('recomp.releases.inUse')}
              currentNote={installed?.pinnedTag ? t('recomp.releases.pinned') : null}
              unavailable={unavailable}
              actionLabel={versionActionLabel(!!installed)}
              busy={busy}
              onAction={() => onAction(release)}
              repoUrl={entry.repoUrl}
              focusKeys={{
                notes: focusKey(`version:${release.tag}:notes`),
                action: focusKey(`version:${release.tag}:use`)
              }}
            />
          ))}
        </div>
      )}
      {!all && items.length > VERSIONS_SHOWN ? (
        <Button
          focusKey={focusKey('versions:all')}
          variant="ghost"
          icon={<ChevronDown />}
          onPress={() => {
            // The button goes once pressed: focus moves to the first newly shown release, not out of the list.
            const keys = showAllFocus(items, VERSIONS_SHOWN).map(focusKey)
            setAll(true)
            setTimeout(() => {
              const key = keys.find((k) => doesFocusableExist(k))
              if (key) void setFocus(key)
            }, 0)
          }}
        >
          {t('recomp.releases.showAll', { count: items.length })}
        </Button>
      ) : null}
    </div>
  )
}
