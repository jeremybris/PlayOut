import type { InstalledVrMod, VrModEntry, VrModProgress, VrModsView } from '@shared/vr-mods'
import {
  ArrowBigUp,
  Compass,
  Download,
  FolderOpen,
  Glasses,
  HardDrive,
  RefreshCw,
  RotateCcw,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { api } from '../../../api/client'
import { Button } from '../../../components/Button'
import { Chip } from '../../../components/Chip'
import { Spinner } from '../../../components/Spinner'
import { cx } from '../../../lib/cx'
import { useT } from '../../../i18n'
import { formatBytes } from '../../../lib/format'
import { ipcErrorMessage } from '../../../state/coop'
import { useUiStore } from '../../../state/ui'
import { clearVrModProgress, useVrModsStore, vrModBusy } from '../../../state/vrMods'
import { progressWorthShowing, vrLead, vrProgressText } from '../../VrMods/vrView'
import { fk, log, shortPath } from '../common'
import './recompilations.css'

const SECTION = 'vr'

/**
 * Settings › VR: VR mods for flat PC games (src/main/vr-mods/), from the Flat2VR release list. Browse VR mods (the
 * browser), where downloads go (the VR Mods folder beside Recompilations), Check for updates, and one card per
 * downloaded mod (Update, Open folder, Remove). Downloads are only kept: PlayOut never runs them.
 */
export function VrSection(): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const openModal = useUiStore((s) => s.openModal)
  const version = useVrModsStore((s) => s.version)
  const progress = useVrModsStore((s) => s.progress)
  const [view, setView] = useState<VrModsView | null>(null)
  const [failed, setFailed] = useState(false)
  const [checking, setChecking] = useState(false)

  const load = useCallback(() => {
    api
      .getVrMods()
      .then((next) => {
        setView(next)
        setFailed(false)
      })
      .catch((err) => {
        log.error('getVrMods failed', err)
        setFailed(true)
      })
  }, [])
  useEffect(load, [load, version])

  const fail = useCallback(
    (what: string, fallback: string) => (err: unknown) => {
      log.error(`${what} failed`, err)
      toast(ipcErrorMessage(err) || fallback, 'error')
    },
    [toast]
  )

  const checkUpdates = (): void => {
    if (checking) return
    setChecking(true)
    api
      .checkVrModUpdates()
      .then((updates) => {
        const n = Object.keys(updates).length
        toast(
          n ? t('settingsVr.downloaded.updatesAvailable', { count: n }) : t('settingsVr.upToDate'),
          'info'
        )
        load()
      })
      .catch(fail('checkVrModUpdates', t('settingsVr.checkFailed')))
      .finally(() => setChecking(false))
  }

  const mods = view?.mods ?? []
  const byId = new Map(mods.map((m) => [m.id, m]))
  const rows = Object.values(view?.installed ?? {})
    .map((rec) => ({ rec, mod: byId.get(rec.id) }))
    .sort((a, b) => a.rec.title.localeCompare(b.rec.title))
  const github = mods.filter((m) => m.github).length

  return (
    <>
      <div className="settings-section__header">
        <div>
          <h2 className="settings-section__title">{t('settingsVr.title')}</h2>
          <p className="settings-section__lead">
            {view ? vrLead(mods.length, github, view.updated) : t('settingsVr.lead')}
          </p>
        </div>
      </div>

      {view === null ? (
        failed ? (
          <p className="settings-note settings-note--missing" role="status">
            {t('settingsVr.readFailed')}{' '}
            <Button
              focusKey={fk(SECTION, 'retry')}
              variant="ghost"
              icon={<RotateCcw />}
              onPress={load}
            >
              {t('settingsVr.tryAgain')}
            </Button>
          </p>
        ) : (
          <Spinner label={t('settingsVr.reading')} className="settings-spinner" />
        )
      ) : (
        <>
          <div className="section">
            <div className="section__title">{t('settingsVr.mods.title')}</div>
            <p className="settings-note">{t('settingsVr.mods.note')}</p>
            <div className="settings-row">
              <span className="control__icon">
                <Compass />
              </span>
              <div className="settings-row__text">
                <span className="settings-row__label">{t('settingsVr.mods.browser')}</span>
                <span className="settings-row__desc">
                  {t('settingsVr.mods.browseCount', { count: mods.length, github })}
                </span>
              </div>
              <div className="settings-row__actions">
                <Button
                  focusKey={fk(SECTION, 'browse')}
                  variant="primary"
                  icon={<Compass />}
                  onPress={() => openModal({ type: 'vr-browser' })}
                >
                  {t('settingsVr.mods.browse')}
                </Button>
              </div>
            </div>
            <div className="settings-row">
              <span className="control__icon">
                <HardDrive />
              </span>
              <div className="settings-row__text">
                <span className="settings-row__label">{t('settingsVr.mods.downloadedTo')}</span>
                <span className="settings-row__value" title={view.root}>
                  {shortPath(view.root)}
                </span>
              </div>
              <div className="settings-row__actions">
                <Button
                  focusKey={fk(SECTION, 'root')}
                  icon={<FolderOpen />}
                  onPress={() =>
                    api
                      .openVrModFolder(null)
                      .catch(fail('openVrModFolder', t('settingsVr.openFolderFailed')))
                  }
                >
                  {t('settingsVr.mods.open')}
                </Button>
              </div>
            </div>
          </div>

          <div className="section">
            <div className="section__title">{t('settingsVr.downloaded.title')}</div>
            {rows.length ? (
              <div className="settings-row">
                <span className="control__icon">
                  <Download />
                </span>
                <div className="settings-row__text">
                  <span className="settings-row__label">
                    {Object.keys(view.updates).length
                      ? t('settingsVr.downloaded.updatesAvailable', {
                          count: Object.keys(view.updates).length
                        })
                      : t('settingsVr.downloaded.updates')}
                  </span>
                  <span className="settings-row__desc">
                    {t('settingsVr.downloaded.updatesNote')}
                  </span>
                </div>
                <div className="settings-row__actions">
                  <Button
                    focusKey={fk(SECTION, 'check')}
                    icon={checking ? <Spinner size="sm" /> : <RefreshCw />}
                    onPress={checkUpdates}
                    aria-disabled={checking}
                  >
                    {t('settingsVr.downloaded.check')}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="settings-note">{t('settingsVr.downloaded.none')}</p>
            )}
            {rows.map(({ rec, mod }) => (
              <VrModCard
                key={rec.id}
                rec={rec}
                mod={mod}
                update={view.updates[rec.id]}
                progress={progress[rec.id]}
                fail={fail}
                onRemove={() => {
                  if (vrModBusy(progress[rec.id])) return
                  openModal({
                    type: 'confirm',
                    title: t('settingsVr.remove.title', { title: rec.title }),
                    message: t('settingsVr.remove.message'),
                    confirmLabel: t('settingsVr.remove.confirm'),
                    danger: true,
                    onConfirm: () =>
                      api
                        .removeVrMod(rec.id)
                        .then(() => {
                          clearVrModProgress(rec.id)
                          toast(t('settingsVr.remove.done', { title: rec.title }), 'success')
                        })
                        .catch(
                          fail('removeVrMod', t('settingsVr.remove.failed', { title: rec.title }))
                        )
                  })
                }}
              />
            ))}
          </div>
        </>
      )}
    </>
  )
}

/** One downloaded mod: its version, size and progress; Update, Open folder, Remove. */
function VrModCard({
  rec,
  mod,
  update,
  progress,
  fail,
  onRemove
}: {
  rec: InstalledVrMod
  mod: VrModEntry | undefined
  update: string | undefined
  progress: VrModProgress | undefined
  fail: (what: string, fallback: string) => (err: unknown) => void
  onRemove: () => void
}): ReactElement {
  const t = useT()
  const key = (name: string): string => fk(SECTION, `${rec.id}:${name}`)
  const busy = vrModBusy(progress)
  const detail = [
    rec.tag,
    rec.asset,
    rec.diskBytes !== null
      ? t('settingsVr.card.onDisk', { size: formatBytes(rec.diskBytes) })
      : null,
    rec.verified === 'unverified' ? t('settingsVr.card.notVerified') : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className={cx('settings-card', 'settings-recomp-card')}>
      <div className="settings-row">
        <span
          className="control__icon"
          style={mod?.accent ? ({ color: mod.accent } as CSSProperties) : undefined}
        >
          <Glasses />
        </span>
        <div className="settings-row__text">
          <span className="settings-row__label">
            {rec.title}
            {update && !busy ? (
              <Chip accent className="settings-row__chip">
                {t('settingsVr.card.available', { version: update })}
              </Chip>
            ) : null}
          </span>
          <span className="settings-row__value" title={rec.dir}>
            {detail}
          </span>
          {progressWorthShowing(progress, busy) && progress ? (
            <>
              <span
                className={cx(
                  'settings-row__desc',
                  progress.phase === 'failed' && 'settings-recomp-card__error'
                )}
                aria-live="polite"
              >
                {vrProgressText(progress)}
              </span>
              {busy ? (
                <span
                  className={cx(
                    'update-progress',
                    progress.phase !== 'downloading' && 'update-progress--indeterminate'
                  )}
                  style={{ '--p': Math.round((progress.progress ?? 0) * 100) } as CSSProperties}
                />
              ) : null}
              {progress.warning ? (
                <span className="settings-row__desc settings-recomp-card__warning">
                  <TriangleAlert aria-hidden />
                  {progress.warning}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="settings-row__actions">
          {update || busy ? (
            <Button
              focusKey={key('update')}
              variant="primary"
              icon={busy ? <Spinner size="sm" /> : <ArrowBigUp />}
              onPress={() => {
                if (busy) return
                api
                  .updateVrMod(rec.id)
                  .catch(
                    fail('updateVrMod', t('settingsVr.card.updateFailed', { title: rec.title }))
                  )
              }}
              aria-disabled={busy}
            >
              {busy
                ? progress?.phase === 'removing'
                  ? t('settingsVr.card.removing')
                  : t('settingsVr.card.downloading')
                : t('settingsVr.card.updateTo', { version: update ?? '' })}
            </Button>
          ) : null}
          <Button
            focusKey={key('folder')}
            icon={<FolderOpen />}
            onPress={() =>
              api
                .openVrModFolder(rec.id)
                .catch(fail('openVrModFolder', t('settingsVr.openFolderFailed')))
            }
          >
            {t('settingsVr.card.openFolder')}
          </Button>
          <Button
            focusKey={key('remove')}
            variant="ghost"
            icon={<Trash2 />}
            onPress={onRemove}
            aria-disabled={busy}
          >
            {t('settingsVr.card.remove')}
          </Button>
        </div>
      </div>
    </div>
  )
}
