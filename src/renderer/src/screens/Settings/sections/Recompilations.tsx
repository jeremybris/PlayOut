import type { RecompProgress, RecompRow, RecompSettingsView } from '@shared/recomp'
import { recompOnlyKey } from '@shared/recomp-play'
import {
  ArrowBigUp,
  ChevronDown,
  Compass,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  FolderInput,
  FolderOpen,
  FolderPlus,
  HardDrive,
  History,
  LibraryBig,
  Plus,
  RefreshCw,
  Repeat,
  RotateCcw,
  Save,
  ScanSearch,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { api } from '../../../api/client'
import { Button } from '../../../components/Button'
import { Chip } from '../../../components/Chip'
import { SelectField } from '../../../components/SelectField'
import { Spinner } from '../../../components/Spinner'
import { Toggle } from '../../../components/Toggle'
import { useT } from '../../../i18n'
import { cx } from '../../../lib/cx'
import { formatBytes } from '../../../lib/format'
import { coverUrl } from '../../../lib/media'
import { ipcErrorMessage } from '../../../state/coop'
import { useLibraryStore } from '../../../state/library'
import {
  clearRecompProgress,
  recompBusy,
  useRecompStore,
  whenRecompFinished
} from '../../../state/recomp'
import { originalImageLines, useRecompImageStore } from '../../../state/recompImage'
import { useUiStore } from '../../../state/ui'
import { OriginalImageDelete } from '../../Recomp/OriginalImageDelete'
import { hostName } from '../../Recomp/recompView'
import { backToLatest } from '../../Recomp/recompVersions'
import { VersionManager } from '../../Recomp/VersionManager'
import { fk, log, shortPath } from '../common'
import {
  browseText,
  catalogFetched,
  canRemoveSave,
  catalogLead,
  cloudStatusText,
  progressText,
  rowDetail,
  keptSaveText,
  saveSourceText,
  updateAllLabel,
  versionOptions
} from './recompText'
import './recompilations.css'

const SECTION = 'recompilations'

/**
 * Settings › Recompilations: native PC ports of the library's console games (src/main/recomp/). The catalogs and
 * Refresh; Check for updates / Update all; one card per installed recompilation (Update, Update automatically, the
 * version a game uses, Open folder, Uninstall, and its saves: folders, suggestions, Find automatically, the copy in
 * the Emulation folder and conflicts); where the save copies live (<Emulation folder>/Recompilations Saves).
 */
/** The game of these ids is a recompilation's own card with this one recompilation installed: deleting it removes it. */
function leavesLibrary(gameIds: readonly string[]): boolean {
  const byId = useLibraryStore.getState().byId
  return gameIds.some((id) => {
    const game = byId.get(id)
    return !!game && !!recompOnlyKey(game) && (game.metadata.recomp?.installed.length ?? 0) <= 1
  })
}

export function RecompilationsSection(): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const openModal = useUiStore((s) => s.openModal)
  const version = useRecompStore((s) => s.version)
  const progress = useRecompStore((s) => s.progress)
  const [view, setView] = useState<RecompSettingsView | null>(null)
  const [failed, setFailed] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [checking, setChecking] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** Rows with a save action running (sync, detect, add), so their buttons show it. */
  const [saveBusy, setSaveBusy] = useState<Set<string>>(new Set())

  const load = useCallback(() => {
    api
      .getRecompSettings()
      .then((next) => {
        setView(next)
        setFailed(false)
      })
      .catch((err) => {
        log.error('getRecompSettings failed', err)
        setFailed(true)
      })
  }, [])
  // A delete question answered (Keep it) changes what a card's Delete… says.
  const imageOffers = useRecompImageStore((s) => s.offers)
  // Read again whenever main says something changed (installs, swaps, saves, the catalog, the delete questions).
  useEffect(load, [load, version, imageOffers])

  const fail = useCallback(
    (what: string, fallback: string) => (err: unknown) => {
      log.error(`${what} failed`, err)
      toast(ipcErrorMessage(err) || fallback, 'error')
    },
    [toast]
  )

  const refresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    api
      .refreshRecompCatalog()
      .then((catalog) => {
        setView((v) => (v ? { ...v, catalog } : v))
        toast(
          catalog.offline.length
            ? t('settingsRecomp.catalog.someOffline')
            : t('settingsRecomp.catalog.updated'),
          catalog.offline.length ? 'info' : 'success'
        )
      })
      .catch(fail('refreshRecompCatalog', t('settingsRecomp.catalog.updateFailed')))
      .finally(() => setRefreshing(false))
  }

  const checkUpdates = (): void => {
    if (checking) return
    setChecking(true)
    api
      .checkRecompUpdates()
      .then((updates) => {
        const n = Object.keys(updates).length
        toast(
          n
            ? t('settingsRecomp.installed.updatesAvailable', { count: n })
            : t('settingsRecomp.installed.upToDate'),
          'info'
        )
        load()
      })
      .catch(fail('checkRecompUpdates', t('settingsRecomp.installed.checkFailed')))
      .finally(() => setChecking(false))
  }

  const updateAll = (): void => {
    if (!updates) return
    api
      .updateAllRecomps()
      .catch(fail('updateAllRecomps', t('settingsRecomp.installed.updatesFailed')))
  }

  const rows = view?.rows ?? []
  const updates = rows.filter((r) => r.update && !recompBusy(progress[r.entry.id])).length

  return (
    <>
      <div className="settings-section__header">
        <div>
          <h2 className="settings-section__title">{t('settingsRecomp.title')}</h2>
          <p className="settings-section__lead">
            {view ? catalogLead(view.catalog) : t('settingsRecomp.lead')}
          </p>
        </div>
      </div>

      {view === null ? (
        failed ? (
          <p className="settings-note settings-note--missing" role="status">
            {t('settingsRecomp.readFailed')}{' '}
            <Button
              focusKey={fk(SECTION, 'retry')}
              variant="ghost"
              icon={<RotateCcw />}
              onPress={load}
            >
              {t('settingsRecomp.tryAgain')}
            </Button>
          </p>
        ) : (
          <Spinner label={t('settingsRecomp.reading')} className="settings-spinner" />
        )
      ) : (
        <>
          <div className="section">
            <div className="section__title">{t('settingsRecomp.catalog.title')}</div>
            <p className="settings-note">{t('settingsRecomp.catalog.note')}</p>
            <div className="settings-row">
              <span className="control__icon">
                <LibraryBig />
              </span>
              <div className="settings-row__text">
                <span className="settings-row__label">
                  {t('settingsRecomp.catalog.titles', { count: view.catalog.titles })}
                </span>
                <span className="settings-row__desc">{catalogFetched(view.catalog)}</span>
              </div>
              <div className="settings-row__actions">
                <Button
                  focusKey={fk(SECTION, 'refresh')}
                  icon={
                    refreshing || view.catalog.refreshing ? <Spinner size="sm" /> : <RefreshCw />
                  }
                  onPress={refresh}
                  aria-disabled={refreshing || view.catalog.refreshing}
                >
                  {refreshing || view.catalog.refreshing
                    ? t('settingsRecomp.catalog.refreshing')
                    : t('settingsRecomp.catalog.refresh')}
                </Button>
              </div>
            </div>
            <div className="settings-row">
              <span className="control__icon">
                <Compass />
              </span>
              <div className="settings-row__text">
                <span className="settings-row__label">{t('settingsRecomp.catalog.browser')}</span>
                <span className="settings-row__desc">
                  {browseText(view.catalog.entries, view.catalog.newEntries ?? 0)}
                </span>
              </div>
              <div className="settings-row__actions">
                <Button
                  focusKey={fk(SECTION, 'browse')}
                  variant="primary"
                  icon={<Compass />}
                  onPress={() => openModal({ type: 'recomp-browser' })}
                >
                  {view.catalog.newEntries
                    ? t('settingsRecomp.catalog.browseNew', { count: view.catalog.newEntries })
                    : t('settingsRecomp.catalog.browse')}
                </Button>
              </div>
            </div>
            <div className="settings-row">
              <span className="control__icon">
                <HardDrive />
              </span>
              <div className="settings-row__text">
                <span className="settings-row__label">
                  {t('settingsRecomp.catalog.installedIn')}
                </span>
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
                      .openPath(view.root)
                      .catch(fail('openPath', t('settingsRecomp.openFolderFailed')))
                  }
                >
                  {t('settingsRecomp.open')}
                </Button>
              </div>
            </div>
          </div>

          <div className="section">
            <div className="section__title">{t('settingsRecomp.installed.title')}</div>
            {rows.length ? (
              <div className="settings-row">
                <span className="control__icon">
                  <Download />
                </span>
                <div className="settings-row__text">
                  <span className="settings-row__label">
                    {updates
                      ? t('settingsRecomp.installed.updatesAvailable', { count: updates })
                      : t('settingsRecomp.installed.updates')}
                  </span>
                  <span className="settings-row__desc">
                    {t('settingsRecomp.installed.updatesNote')}
                  </span>
                </div>
                <div className="settings-row__actions">
                  <Button
                    focusKey={fk(SECTION, 'check')}
                    icon={checking ? <Spinner size="sm" /> : <RefreshCw />}
                    onPress={checkUpdates}
                    aria-disabled={checking}
                  >
                    {t('settingsRecomp.installed.check')}
                  </Button>
                  <Button
                    focusKey={fk(SECTION, 'update-all')}
                    variant={updates ? 'primary' : 'secondary'}
                    icon={<ArrowBigUp />}
                    onPress={updateAll}
                    aria-disabled={!updates}
                  >
                    {updateAllLabel(updates)}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="settings-note">{t('settingsRecomp.installed.none')}</p>
            )}
            {rows.map((row) => (
              <RecompCard
                key={row.entry.id}
                row={row}
                progress={progress[row.entry.id]}
                open={expanded.has(row.entry.id)}
                saveBusy={saveBusy.has(row.entry.id)}
                onToggleOpen={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev)
                    if (next.has(row.entry.id)) next.delete(row.entry.id)
                    else next.add(row.entry.id)
                    return next
                  })
                }
                onSaveBusy={(busy) =>
                  setSaveBusy((prev) => {
                    const next = new Set(prev)
                    if (busy) next.add(row.entry.id)
                    else next.delete(row.entry.id)
                    return next
                  })
                }
                onChanged={load}
                onUninstall={() => {
                  if (recompBusy(progress[row.entry.id])) return
                  openModal({
                    type: 'confirm',
                    title: t('settingsRecomp.uninstall.title', { name: row.entry.name }),
                    // Whole sentences: what happens to the folder and saves, then (when it does) the library.
                    message:
                      (row.installed.cloud.enabled
                        ? t('settingsRecomp.uninstall.messageCloud')
                        : t('settingsRecomp.uninstall.message')) +
                      (leavesLibrary(row.gameIds)
                        ? ` ${t('settingsRecomp.uninstall.leavesLibrary')}`
                        : ''),
                    confirmLabel: t('settingsRecomp.uninstall.confirm'),
                    danger: true,
                    onConfirm: () =>
                      api
                        .uninstallRecomp(row.entry.id)
                        .then(() => {
                          clearRecompProgress(row.entry.id)
                          toast(
                            t('settingsRecomp.uninstall.done', { name: row.entry.name }),
                            'success'
                          )
                        })
                        .catch(
                          fail(
                            'uninstallRecomp',
                            t('settingsRecomp.uninstall.failed', { name: row.entry.name })
                          )
                        )
                  })
                }}
                fail={fail}
              />
            ))}
          </div>

          <SaveCopies view={view} fail={fail} />
        </>
      )}
    </>
  )
}

interface RecompCardProps {
  row: RecompRow
  progress: RecompProgress | undefined
  open: boolean
  saveBusy: boolean
  onToggleOpen: () => void
  onSaveBusy: (busy: boolean) => void
  onChanged: () => void
  onUninstall: () => void
  fail: (what: string, fallback: string) => (err: unknown) => void
}

/** One installed recompilation: its update, the version its game uses, folders, and (expanded) its saves. */
function RecompCard({
  row,
  progress,
  open,
  saveBusy,
  onToggleOpen,
  onSaveBusy,
  onChanged,
  onUninstall,
  fail
}: RecompCardProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const id = row.entry.id
  const key = (name: string): string => fk(SECTION, `${id}:${name}`)
  const pinned = row.installed.pinnedTag ?? null
  const games = useLibraryStore((s) => s.byId)
  const game = row.gameIds.map((g) => games.get(g)).find((g) => g !== undefined)
  const gameName = game ? game.user.titleOverride || game.title : row.entry.game
  const art =
    row.entry.coverUrl ?? (game ? coverUrl(game) : undefined) ?? row.entry.iconUrl ?? undefined
  const busy = recompBusy(progress)
  const showProgress = !!progress && (busy || progress.phase === 'failed' || !!progress.warning)
  const inUse = game?.metadata.recomp?.preferred ?? id
  const conflict = row.installed.cloud.enabled ? row.installed.cloud.conflict : null
  const hasSaves = row.installed.savePaths.length > 0
  /** False for the one folder from the catalog or the developer's file: main falls back to it again. */
  const removable = canRemoveSave(row.installed.saveSource, row.installed.savePaths.length)
  const keptNote = keptSaveText(row.installed.saveSource, row.installed.savePaths.length)

  const update = (): void => {
    if (busy) return
    api
      .updateRecomp(id)
      .catch(fail('updateRecomp', t('settingsRecomp.card.updateFailed', { name: row.entry.name })))
  }

  const swap = (target: string): void => {
    if (busy || target === inUse) return
    const alternative = row.alternatives.find((a) => a.id === target)
    const name = alternative?.name ?? row.entry.name
    const choose = (): Promise<void> =>
      Promise.all(row.gameIds.map((gameId) => api.setPreferredRecomp(gameId, target)))
        .then(() => {
          toast(t('settingsRecomp.card.nowUses', { game: gameName, name }), 'success')
        })
        .catch(fail('setPreferredRecomp', t('settingsRecomp.card.switchFailed', { name })))
    if (!alternative || alternative.installed) {
      void choose()
      return
    }
    // installRecomp only queues the install, so the game keeps the version it uses until the new one is
    // installed; if the install fails, nothing changes.
    const before = useRecompStore.getState().progress[target]
    api
      .installRecomp(target)
      .then(() => {
        toast(t('settingsRecomp.card.installing', { name, game: gameName }), 'info')
        return whenRecompFinished(target, before).then(choose, (err: unknown) => {
          log.error('installRecomp failed', err)
          const why = ipcErrorMessage(err)
          toast(
            why
              ? t('settingsRecomp.card.installFailedWhy', { name, why, game: gameName })
              : t('settingsRecomp.card.installFailed', { name, game: gameName }),
            'error'
          )
        })
      })
      .catch(fail('installRecomp', t('settingsRecomp.card.installQueueFailed', { name })))
  }

  const saveAction = <T,>(
    what: string,
    fallback: string,
    run: () => Promise<T>,
    done?: (v: T) => void
  ): void => {
    if (saveBusy) return
    onSaveBusy(true)
    run()
      .then((value) => {
        done?.(value)
        onChanged()
      })
      .catch(fail(what, fallback))
      .finally(() => onSaveBusy(false))
  }

  const removeSave = (index: number): void => {
    if (!removable) return
    saveAction('setRecompSavePaths', t('settingsRecomp.saves.removeFailed'), () =>
      api.setRecompSavePaths(
        id,
        row.installed.savePaths.filter((_, i) => i !== index)
      )
    )
  }

  // 'fresh' only to "the saves are gone" (main refuses it once the saves came back); 'cloud' restores them then.
  const resolve = (keep: 'local' | 'cloud' | 'fresh', gone = false): void =>
    saveAction(
      'resolveRecompConflict',
      t('settingsRecomp.saves.keepFailed'),
      () => api.resolveRecompConflict(id, keep),
      () =>
        toast(
          keep === 'fresh'
            ? t('recomp.page.startedFresh')
            : keep === 'local'
              ? t('settingsRecomp.saves.keptLocal')
              : gone
                ? t('recomp.page.restored')
                : t('settingsRecomp.saves.keptCloud'),
          'success'
        )
    )

  const addSave = (path?: string): void =>
    saveAction('addRecompSaveFolder', t('settingsRecomp.saves.addFailed'), () =>
      api.addRecompSaveFolder(id, path)
    )

  const findSaves = (): void =>
    saveAction(
      'findRecompSaveFolders',
      t('settingsRecomp.saves.findFailed'),
      () => api.findRecompSaveFolders(id),
      (saves) =>
        toast(
          saves.suggestions.length
            ? t('settingsRecomp.saves.found', { count: saves.suggestions.length })
            : saves.resolved.length
              ? t('settingsRecomp.saves.using', { count: saves.resolved.length })
              : t('settingsRecomp.saves.notFound'),
          'info'
        )
    )

  return (
    <div
      className={cx(
        'settings-card',
        'settings-recomp-card',
        conflict && 'settings-recomp-card--conflict'
      )}
    >
      <div className="settings-row">
        {art ? (
          <img
            className="settings-recomp-card__art"
            src={art}
            alt=""
            loading="lazy"
            draggable={false}
          />
        ) : (
          <span className="control__icon">
            <ArrowBigUp />
          </span>
        )}
        <div className="settings-row__text">
          <span className="settings-row__label">
            {row.entry.name}
            {row.update && !busy ? (
              <Chip accent className="settings-row__chip">
                {t('settingsRecomp.card.available', { version: row.update })}
              </Chip>
            ) : null}
            {pinned && !busy ? (
              <Chip className="settings-row__chip">
                {t('settingsRecomp.card.pinnedTo', { version: pinned })}
              </Chip>
            ) : null}
            {conflict ? (
              <Chip className="settings-row__chip settings-row__chip--warn">
                {t('settingsRecomp.card.conflict')}
              </Chip>
            ) : null}
          </span>
          <span className="settings-row__value">{rowDetail(row, gameName)}</span>
          {showProgress && progress ? (
            <>
              <span
                className={cx(
                  'settings-row__desc',
                  progress.phase === 'failed' && 'settings-recomp-card__error'
                )}
                aria-live="polite"
              >
                {progressText(progress)}
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
          {row.update || busy ? (
            <Button
              focusKey={key('update')}
              variant="primary"
              icon={busy ? <Spinner size="sm" /> : <ArrowBigUp />}
              onPress={update}
              aria-disabled={busy}
            >
              {busy
                ? t('settingsRecomp.card.updating')
                : t('settingsRecomp.card.updateTo', { version: row.update ?? '' })}
            </Button>
          ) : pinned ? (
            <Button
              focusKey={key('update')}
              variant="primary"
              icon={<ArrowBigUp />}
              onPress={() => {
                if (!busy) backToLatest(row.entry, toast, fail)
              }}
            >
              {t('settingsRecomp.card.backToLatest')}
            </Button>
          ) : null}
          <Button
            focusKey={key('folder')}
            icon={<FolderOpen />}
            onPress={() =>
              api
                .openRecompFolder(id, 'install')
                .catch(fail('openRecompFolder', t('settingsRecomp.openFolderFailed')))
            }
          >
            {t('settingsRecomp.card.openFolder')}
          </Button>
          <Button
            focusKey={key('repo')}
            icon={<ExternalLink />}
            onPress={() =>
              api
                .openExternal(row.entry.repoUrl)
                .catch(
                  fail(
                    'openExternal',
                    t('settingsRecomp.card.openHostFailed', { host: hostName(row.entry.host) })
                  )
                )
            }
            aria-label={t('settingsRecomp.card.openHostLabel', {
              host: hostName(row.entry.host),
              name: row.entry.name
            })}
          >
            {hostName(row.entry.host)}
          </Button>
          <Button
            focusKey={key('saves')}
            variant="ghost"
            icon={<Save />}
            iconRight={open ? <ChevronUp /> : <ChevronDown />}
            onPress={onToggleOpen}
            aria-label={
              open
                ? t('settingsRecomp.card.hideSaves', { name: row.entry.name })
                : t('settingsRecomp.card.showSaves', { name: row.entry.name })
            }
          >
            {t('settingsRecomp.card.saves')}
          </Button>
          <Button
            focusKey={key('uninstall')}
            variant="ghost"
            icon={<Trash2 />}
            onPress={onUninstall}
            aria-disabled={busy}
          >
            {t('settingsRecomp.card.uninstall')}
          </Button>
        </div>
      </div>

      <VersionManager
        layout="settings"
        entry={row.entry}
        installed={row.installed}
        update={row.update}
        release={row.release}
        busy={busy}
        focusKey={key}
        fail={fail}
      />

      <Toggle
        focusKey={key('auto')}
        className="settings-recomp-card__control"
        icon={<History />}
        label={t('settingsRecomp.card.autoUpdate.label')}
        description={
          pinned
            ? t('settingsRecomp.card.autoUpdate.paused', { name: row.entry.name, version: pinned })
            : t('settingsRecomp.card.autoUpdate.description')
        }
        checked={row.installed.autoUpdate}
        onChange={(on) =>
          api
            .setRecompAutoUpdate(id, on)
            .then(onChanged)
            .catch(fail('setRecompAutoUpdate', t('settingsRecomp.card.autoUpdate.failed')))
        }
      />

      {row.alternatives.length ? (
        <SelectField
          focusKey={key('version')}
          className="settings-recomp-card__control"
          icon={<Repeat />}
          label={t('settingsRecomp.card.version.label', { game: gameName })}
          description={t('settingsRecomp.card.version.description', {
            count: row.alternatives.length + 1
          })}
          value={inUse}
          options={versionOptions(row)}
          onChange={swap}
          disabled={busy}
        />
      ) : null}

      {row.originalImage ? (
        <div
          className="settings-recomp-delete"
          role="group"
          aria-label={t('settingsRecomp.card.deleteGroup', { name: row.entry.name })}
        >
          <Trash2 className="settings-recomp-delete__icon" aria-hidden />
          <div className="settings-recomp-delete__text">
            {originalImageLines(
              row.entry.name,
              row.originalImage,
              row.originalImage.folder?.totalBytes != null
                ? formatBytes(row.originalImage.folder.totalBytes)
                : null
            ).map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
          <OriginalImageDelete
            gameId={row.originalImage.gameId}
            recompId={id}
            image={row.originalImage}
            focusKeys={{ what: key('original-image:what'), delete: key('original-image') }}
            toast={toast}
            className="settings-recomp-delete__actions"
          />
        </div>
      ) : null}

      {conflict ? (
        <div className="settings-recomp-conflict" role="alert">
          <TriangleAlert className="settings-recomp-conflict__icon" aria-hidden />
          <span className="settings-recomp-conflict__text">
            {cloudStatusText(row.installed.cloud)}
          </span>
          {conflict.gone ? (
            // The saves are gone from this PC: Restore first, as on the recompilation's page and Play's question.
            <div className="settings-row__actions">
              <Button
                focusKey={key('keep-cloud')}
                icon={<Copy />}
                onPress={() => resolve('cloud', true)}
                aria-disabled={saveBusy}
              >
                {t('recomp.conflict.restore')}
              </Button>
              <Button
                focusKey={key('keep-local')}
                icon={<HardDrive />}
                onPress={() => resolve('fresh', true)}
                aria-disabled={saveBusy}
              >
                {t('recomp.conflict.startFresh')}
              </Button>
            </div>
          ) : (
            <div className="settings-row__actions">
              <Button
                focusKey={key('keep-local')}
                icon={<HardDrive />}
                onPress={() => resolve('local')}
                aria-disabled={saveBusy}
              >
                {t('settingsRecomp.card.keepLocal')}
              </Button>
              <Button
                focusKey={key('keep-cloud')}
                icon={<Copy />}
                onPress={() => resolve('cloud')}
                aria-disabled={saveBusy}
              >
                {t('settingsRecomp.card.keepCloud')}
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {open ? (
        <div className="settings-recomp-saves">
          <span className="settings-paths__title">{t('settingsRecomp.saves.folders')}</span>
          <span className="settings-recomp-saves__source">
            {saveSourceText(row.installed.saveSource, row.installed.savePaths.length)}
          </span>
          {row.installed.savePaths.map((template, i) => {
            const real = row.resolvedSavePaths[i] ?? template
            return (
              <div key={template} className="settings-recomp-saves__folder">
                <span className="settings-paths__item" title={template}>
                  {real}
                </span>
                {removable ? (
                  <Button
                    focusKey={key(`save:${i}:remove`)}
                    variant="ghost"
                    icon={<X />}
                    onPress={() => removeSave(i)}
                    aria-disabled={saveBusy}
                    aria-label={t('settingsRecomp.saves.stopUsing', { path: real })}
                  >
                    {t('settingsRecomp.saves.remove')}
                  </Button>
                ) : null}
              </div>
            )
          })}
          {keptNote ? <span className="settings-recomp-saves__source">{keptNote}</span> : null}
          {row.saveSuggestions.length ? (
            <>
              <span className="settings-paths__title">{t('settingsRecomp.saves.suggestions')}</span>
              {row.saveSuggestions.map((path, i) => (
                <div key={path} className="settings-recomp-saves__folder">
                  <span className="settings-paths__item settings-recomp-saves__suggestion">
                    {path}
                  </span>
                  <Button
                    focusKey={key(`save:suggest:${i}`)}
                    variant="ghost"
                    icon={<Plus />}
                    onPress={() => addSave(path)}
                    aria-disabled={saveBusy}
                    aria-label={t('settingsRecomp.saves.use', { path })}
                  >
                    {t('settingsRecomp.saves.add')}
                  </Button>
                </div>
              ))}
            </>
          ) : null}
          <div className="settings-recomp-saves__actions">
            <Button
              focusKey={key('save:add')}
              icon={<FolderPlus />}
              onPress={() => addSave()}
              aria-disabled={saveBusy}
            >
              {t('settingsRecomp.saves.addFolder')}
            </Button>
            <Button
              focusKey={key('save:detect')}
              variant="ghost"
              icon={saveBusy ? <Spinner size="sm" /> : <ScanSearch />}
              onPress={findSaves}
              aria-disabled={saveBusy}
            >
              {t('settingsRecomp.saves.find')}
            </Button>
            <Button
              focusKey={key('save:open')}
              variant="ghost"
              icon={<FolderOpen />}
              onPress={() => {
                if (!row.resolvedSavePaths.length) return
                api
                  .openRecompFolder(id, 'saves')
                  .catch(fail('openRecompFolder', t('settingsRecomp.openFolderFailed')))
              }}
              aria-disabled={!row.resolvedSavePaths.length}
            >
              {t('settingsRecomp.open')}
            </Button>
          </div>
          <Toggle
            focusKey={key('cloud')}
            className="settings-recomp-saves__cloud"
            icon={<Copy />}
            label={t('settingsRecomp.saves.cloud.label')}
            description={
              conflict
                ? t('settingsRecomp.saves.cloud.conflict')
                : cloudStatusText(row.installed.cloud)
            }
            checked={row.installed.cloud.enabled}
            onChange={(on) =>
              api
                .setRecompCloud(id, on)
                .then(onChanged)
                .catch(fail('setRecompCloud', t('settingsRecomp.saves.cloud.failed')))
            }
          />
          <div className="settings-recomp-saves__folder">
            <span className="settings-paths__item" title={row.savesDir}>
              {t('settingsRecomp.saves.copiesIn', { path: shortPath(row.savesDir, 64) })}
            </span>
            <Button
              focusKey={key('copies:open')}
              variant="ghost"
              icon={<FolderInput />}
              onPress={() =>
                api
                  .openRecompFolder(id, 'copies')
                  .catch(fail('openRecompFolder', t('settingsRecomp.openFolderFailed')))
              }
            >
              {t('settingsRecomp.open')}
            </Button>
          </div>
          {row.installed.cloud.enabled && !conflict ? (
            <div className="settings-recomp-saves__actions">
              <Button
                focusKey={key('sync')}
                icon={saveBusy ? <Spinner size="sm" /> : <RefreshCw />}
                onPress={() => {
                  if (!hasSaves) return
                  saveAction(
                    'syncRecompSaves',
                    t('settingsRecomp.saves.copyFailed'),
                    () => api.syncRecompSaves(id),
                    (state) =>
                      toast(
                        state.conflict
                          ? t('settingsRecomp.saves.bothChanged')
                          : state.error
                            ? state.error
                            : t('settingsRecomp.saves.copied'),
                        state.conflict || state.error ? 'info' : 'success'
                      )
                  )
                }}
                aria-disabled={saveBusy || !hasSaves}
              >
                {t('settingsRecomp.saves.copyNow')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Where the save copies live: <Emulation folder>/Recompilations Saves, following Settings › Library's Emulation
 * folder. That folder is what PlayOut's streaming sync shares with your other PCs (and it can sit in a cloud app's
 * folder), so that is how saves reach them.
 */
function SaveCopies({
  view,
  fail
}: {
  view: RecompSettingsView
  fail: (what: string, fallback: string) => (err: unknown) => void
}): ReactElement {
  const t = useT()
  return (
    <div className="section">
      <div className="section__title">{t('settingsRecomp.copies.title')}</div>
      <p className="settings-note">{t('settingsRecomp.copies.note')}</p>
      <div className="settings-row">
        <span className="control__icon">
          <Copy />
        </span>
        <div className="settings-row__text">
          <span className="settings-row__label">{t('settingsRecomp.copies.copiedTo')}</span>
          <span className="settings-row__value" title={view.savesDir}>
            {shortPath(view.savesDir)}
          </span>
        </div>
        <div className="settings-row__actions">
          <Button
            focusKey={fk(SECTION, 'copies-open')}
            icon={<FolderOpen />}
            onPress={() =>
              api
                .openPath(view.savesDir)
                .catch(fail('openPath', t('settingsRecomp.openFolderFailed')))
            }
          >
            {t('settingsRecomp.open')}
          </Button>
        </div>
      </div>
    </div>
  )
}
