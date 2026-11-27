import { findEmulatorCommand } from '@shared/emulators'
import type { EmulatorSetupStatus, EmulatorStatus, SystemInfo } from '@shared/types'
import { updateReportLines, updateSummary } from './emulatorUpdateText'
import {
  ChevronDown,
  ChevronUp,
  Cpu,
  Download,
  FolderOpen,
  Gamepad2,
  HardDrive,
  KeyRound,
  Layers,
  PackagePlus,
  RefreshCw,
  RefreshCwOff,
  X
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { api } from '../../../api/client'
import { Button } from '../../../components/Button'
import { Chip } from '../../../components/Chip'
import { SelectField } from '../../../components/SelectField'
import { Spinner } from '../../../components/Spinner'
import { Toggle } from '../../../components/Toggle'
import { useT } from '../../../i18n'
import { cx } from '../../../lib/cx'
import { orderChoices, orderEmulators, orderSystems } from '../../../lib/emulatorOrder'
import { emulatorSetupBar } from '../../../lib/scanBars'
import { useLibraryStore } from '../../../state/library'
import { useUiStore } from '../../../state/ui'
import { fk, log, shortPath, type SectionProps } from '../common'
import { PathRow } from '../PathRow'
import { RetroAchievementsAccount } from '../RetroAchievementsAccount'

const SECTION = 'emulators'

/**
 * The RetroAchievements account, PlayOut's own emulators (where they are installed, the BIOS folder, Set up
 * emulators), emulator detection with Browse / Clear / Install / Download, the RetroArch cores folder and per-system
 * choices.
 */
export function EmulatorsSection({ settings, patch }: SectionProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const [emulators, setEmulators] = useState<EmulatorStatus[] | null>(null)
  const [systems, setSystems] = useState<SystemInfo[] | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = useCallback(() => {
    api
      .getEmulators()
      .then(setEmulators)
      .catch((err) => {
        log.error('getEmulators failed', err)
        toast(t('settingsEmulators.toasts.listFailed'), 'error')
      })
    api
      .getSystems()
      .then(setSystems)
      .catch((err) => {
        log.error('getSystems failed', err)
        toast(t('settingsEmulators.toasts.systemsFailed'), 'error')
      })
  }, [t, toast])
  useEffect(load, [load])

  // PlayOut's own emulators (docs/emulator-setup.md). The progress comes from 'emulator-setup:progress'; each time an
  // emulator finishes (progress.done changes, at most once a second) and when a run ends, the status and the emulator
  // list are read again.
  const [setup, setSetup] = useState<EmulatorSetupStatus | null>(null)
  const progress = useLibraryStore((s) => s.emulatorSetup)
  const running = progress.total > 0
  const loadSetup = useCallback(() => {
    api
      .getEmulatorSetup()
      .then(setSetup)
      .catch((err) => {
        log.error('getEmulatorSetup failed', err)
        toast(t('settingsEmulators.toasts.setupReadFailed'), 'error')
      })
  }, [t, toast])
  useEffect(loadSetup, [loadSetup])
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) {
      loadSetup()
      load()
    }
    wasRunning.current = running
  }, [running, load, loadSetup])

  // While a run is going, an emulator that finished turns from 'Installing…' to installed: re-read both lists when
  // progress.done changes, throttled to once a second with a trailing read so the last change is not lost.
  const lastDone = useRef(progress.done)
  const lastRefresh = useRef(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!running || progress.done === lastDone.current) {
      lastDone.current = progress.done
      return
    }
    lastDone.current = progress.done
    if (refreshTimer.current) return
    const refresh = (): void => {
      refreshTimer.current = null
      lastRefresh.current = Date.now()
      loadSetup()
      load()
    }
    const wait = lastRefresh.current + 1000 - Date.now()
    if (wait <= 0) refresh()
    else refreshTimer.current = setTimeout(refresh, wait)
  }, [running, progress.done, load, loadSetup])
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    },
    []
  )

  const startSetup = useCallback(
    (ids?: string[]) => {
      api
        .setupEmulators(ids)
        .then((next) => {
          setSetup(next)
          // Nothing to do: no progress event will say the run ended.
          if (next.progress.total === 0) load()
        })
        .catch((err) => {
          log.error('setupEmulators failed', err)
          toast(t('settingsEmulators.toasts.setupFailed'), 'error')
        })
    },
    [load, t, toast]
  )

  // Update all emulators: the call resolves when the run has ended (even one with nothing to update, which sends no
  // progress), with its report.
  const [updatePending, setUpdatePending] = useState(false)
  const startUpdate = useCallback(() => {
    setUpdatePending(true)
    api
      .updateEmulators()
      .then((next) => {
        setSetup(next)
        if (next.lastUpdate) {
          const summary = updateSummary(next.lastUpdate)
          toast(summary.text, summary.tone)
        }
        load()
      })
      .catch((err) => {
        log.error('updateEmulators failed', err)
        toast(t('settingsEmulators.toasts.updateFailed'), 'error')
      })
      .finally(() => setUpdatePending(false))
  }, [load, t, toast])

  const openFolder = useCallback(
    (path: string) => {
      api.openPath(path).catch((err) => {
        log.error('openPath failed', err)
        toast(t('settingsEmulators.toasts.folderFailed'), 'error')
      })
    },
    [t, toast]
  )
  const setupRunning = running || (setup?.progress.total ?? 0) > 0

  const setPath = useCallback(
    (emulator: EmulatorStatus, path: string | null) => {
      api
        .setEmulatorPath(emulator.id, path)
        .then((next) => {
          setEmulators(next)
          const overrides = { ...settings.emulators.overrides }
          if (path) overrides[emulator.id] = path
          else delete overrides[emulator.id]
          patch({ emulators: { overrides } })
          toast(
            path
              ? t('settingsEmulators.toasts.pathSet', {
                  name: emulator.name,
                  path: shortPath(path, 48)
                })
              : t('settingsEmulators.toasts.overrideCleared', { name: emulator.name }),
            'success'
          )
        })
        .catch((err) => {
          log.error('setEmulatorPath failed', err)
          toast(t('settingsEmulators.toasts.pathFailed', { name: emulator.name }), 'error')
        })
    },
    [patch, settings.emulators.overrides, t, toast]
  )

  const browse = useCallback(
    (emulator: EmulatorStatus) => {
      api
        .chooseFile({
          title: t('settingsEmulators.pickers.locate', { name: emulator.name }),
          filters: [{ name: t('settingsEmulators.pickers.programs'), extensions: ['exe'] }]
        })
        .then((file) => {
          if (file) setPath(emulator, file)
        })
        .catch((err) => {
          log.error('chooseFile failed', err)
          toast(t('settingsEmulators.toasts.filePickerFailed'), 'error')
        })
    },
    [setPath, t, toast]
  )

  const download = useCallback(
    (emulator: EmulatorStatus) => {
      if (!emulator.downloadUrl) return
      api.openExternal(emulator.downloadUrl).catch((err) => {
        log.error('openExternal failed', err)
        toast(t('settingsEmulators.toasts.downloadFailed'), 'error')
      })
    },
    [t, toast]
  )

  const chooseCoresDir = useCallback(() => {
    api
      .chooseFolder(t('settingsEmulators.pickers.cores'))
      .then((folder) => {
        if (folder) patch({ emulators: { coresDir: folder } })
      })
      .catch((err) => {
        log.error('chooseFolder failed', err)
        toast(t('settingsEmulators.toasts.folderPickerFailed'), 'error')
      })
  }, [patch, t, toast])

  const toggleExpanded = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const retroarch = emulators?.find((e) => e.id === 'RETROARCH')
  const found = emulators?.filter((e) => e.path).length ?? 0

  return (
    <>
      <div className="settings-section__header">
        <div>
          <h2 className="settings-section__title">{t('settingsEmulators.title')}</h2>
          <p className="settings-section__lead">
            {emulators
              ? t('settingsEmulators.lead', { found, total: emulators.length })
              : t('settingsEmulators.leadLoading')}
          </p>
        </div>
      </div>

      <RetroAchievementsAccount credentials={settings.scrapers.retroachievements} />

      <PlayOutEmulators
        status={setup}
        running={setupRunning || updatePending}
        updating={
          updatePending ||
          (setupRunning && (progress.total > 0 ? progress : setup?.progress)?.stage === 'updates')
        }
        progressLabel={emulatorSetupBar(progress)?.label ?? null}
        onSetup={() => startSetup()}
        onUpdate={startUpdate}
        onOpen={openFolder}
      />

      <div className="section">
        <div className="section__title">{t('settingsEmulators.detected.title')}</div>
        {emulators === null ? (
          <Spinner label={t('settingsEmulators.detected.searching')} className="settings-spinner" />
        ) : (
          orderEmulators(emulators).map((emulator) => {
            const open = expanded.has(emulator.id)
            const isFound = !!emulator.path
            const installing =
              setupRunning &&
              (setup?.items.some((i) => i.id === emulator.id && i.state === 'installing') ?? false)
            return (
              <div
                key={emulator.id}
                className={cx('settings-card', !isFound && 'settings-card--missing')}
              >
                <div className="settings-row">
                  <span className="control__icon">
                    <Gamepad2 />
                  </span>
                  <div className="settings-row__text">
                    <span className="settings-row__label">
                      {emulator.name}
                      {emulator.foundBy === 'override' ? (
                        <Chip accent className="settings-row__chip">
                          {t('settingsEmulators.detected.customPath')}
                        </Chip>
                      ) : emulator.foundBy === 'playout' ? (
                        <Chip accent className="settings-row__chip">
                          {t('settingsEmulators.detected.installedByPlayOut')}
                        </Chip>
                      ) : isFound ? (
                        <Chip className="settings-row__chip">
                          {t('settingsEmulators.detected.detected')}
                        </Chip>
                      ) : (
                        <Chip className="settings-row__chip settings-row__chip--warn">
                          {t('settingsEmulators.detected.notFound')}
                        </Chip>
                      )}
                    </span>
                    <span
                      className={cx(
                        'settings-row__value',
                        !isFound && 'settings-row__value--empty'
                      )}
                      title={emulator.path ?? undefined}
                    >
                      {emulator.path
                        ? shortPath(emulator.path)
                        : t('settingsEmulators.detected.notFound')}
                    </span>
                  </div>
                  <div className="settings-row__actions">
                    <Button
                      focusKey={fk(SECTION, `${emulator.id}:browse`)}
                      icon={<FolderOpen />}
                      onPress={() => browse(emulator)}
                    >
                      {t('settingsEmulators.detected.browse')}
                    </Button>
                    {emulator.foundBy === 'override' ? (
                      <Button
                        focusKey={fk(SECTION, `${emulator.id}:clear`)}
                        variant="ghost"
                        icon={<X />}
                        onPress={() => setPath(emulator, null)}
                      >
                        {t('settingsEmulators.detected.clearOverride')}
                      </Button>
                    ) : null}
                    {emulator.installable && !isFound ? (
                      <Button
                        focusKey={fk(SECTION, `${emulator.id}:install`)}
                        variant="secondary"
                        icon={installing ? <Spinner size="sm" /> : <PackagePlus />}
                        disabled={setupRunning}
                        onPress={() => startSetup([emulator.id])}
                      >
                        {installing
                          ? t('settingsEmulators.detected.installing')
                          : t('settingsEmulators.detected.install')}
                      </Button>
                    ) : emulator.downloadUrl ? (
                      <Button
                        focusKey={fk(SECTION, `${emulator.id}:download`)}
                        variant={isFound ? 'ghost' : 'secondary'}
                        icon={<Download />}
                        onPress={() => download(emulator)}
                      >
                        {t('settingsEmulators.detected.download')}
                      </Button>
                    ) : null}
                    <Button
                      focusKey={fk(SECTION, `${emulator.id}:paths`)}
                      variant="ghost"
                      iconRight={open ? <ChevronUp /> : <ChevronDown />}
                      onPress={() => toggleExpanded(emulator.id)}
                      aria-label={
                        open
                          ? t('settingsEmulators.detected.hidePathsLabel', { name: emulator.name })
                          : t('settingsEmulators.detected.showPathsLabel', { name: emulator.name })
                      }
                    >
                      {open
                        ? t('settingsEmulators.detected.hidePaths')
                        : t('settingsEmulators.detected.searchedPaths')}
                    </Button>
                  </div>
                </div>
                {open ? (
                  <div className="settings-paths">
                    <span className="settings-paths__title">
                      {t('settingsEmulators.detected.locationsSearched', {
                        count: emulator.searchedPaths.length
                      })}
                    </span>
                    {emulator.searchedPaths.length === 0 ? (
                      <span className="settings-paths__item">
                        {t('settingsEmulators.detected.noFindRules')}
                      </span>
                    ) : (
                      emulator.searchedPaths.map((path) => (
                        <span key={path} className="settings-paths__item">
                          {path}
                        </span>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      <div className="section">
        <div className="section__title">RetroArch</div>
        <PathRow
          focusKey={fk(SECTION, 'cores')}
          icon={<Layers />}
          label={t('settingsEmulators.cores.label')}
          description={
            retroarch?.coresDir && !settings.emulators.coresDir
              ? t('settingsEmulators.cores.detected', { path: shortPath(retroarch.coresDir) })
              : t('settingsEmulators.cores.description')
          }
          value={settings.emulators.coresDir}
          placeholder={
            retroarch?.coresDir
              ? t('settingsEmulators.cores.autoDetect')
              : t('settingsEmulators.cores.notSet')
          }
          onChoose={chooseCoresDir}
          onClear={() => patch({ emulators: { coresDir: null } })}
        />
      </div>

      <div className="section">
        <div className="section__title">{t('settingsEmulators.ps3.title')}</div>
        <Toggle
          focusKey={fk(SECTION, 'ps3AutoUpdate')}
          icon={<RefreshCw />}
          label={t('settingsEmulators.ps3.label')}
          description={t('settingsEmulators.ps3.description')}
          checked={settings.emulators.ps3AutoUpdate}
          onChange={(v) => patch({ emulators: { ps3AutoUpdate: v } })}
        />
      </div>

      <div className="section">
        <div className="section__title">{t('settingsEmulators.preferred.title')}</div>
        {systems === null ? (
          <Spinner label={t('settingsEmulators.preferred.loading')} className="settings-spinner" />
        ) : systems.length === 0 ? (
          <p className="settings-note">{t('settingsEmulators.preferred.noSystems')}</p>
        ) : (
          orderSystems(systems)
            .filter((system) => system.emulators.length > 0)
            .map((system) => {
              const available = new Set(system.availableEmulators)
              const options = orderChoices(system.emulators, available).map((command) => ({
                value: command.id,
                label: available.has(command.id)
                  ? command.label
                  : t('settingsEmulators.preferred.notFound', { label: command.label })
              }))
              const current =
                findEmulatorCommand(system, settings.emulators.preferred[system.id])?.id ??
                system.emulators[0]?.id ??
                ''
              return (
                <SelectField
                  key={system.id}
                  focusKey={fk(SECTION, `preferred:${system.id}`)}
                  icon={<Cpu />}
                  label={system.name}
                  description={
                    system.gameCount > 0
                      ? t('settingsEmulators.preferred.withGames', {
                          count: system.gameCount,
                          available: system.availableEmulators.length,
                          total: system.emulators.length
                        })
                      : t('settingsEmulators.preferred.available', {
                          available: system.availableEmulators.length,
                          total: system.emulators.length
                        })
                  }
                  value={current}
                  options={options}
                  onChange={(value) =>
                    patch({
                      emulators: {
                        preferred: { ...settings.emulators.preferred, [system.id]: value }
                      }
                    })
                  }
                />
              )
            })
        )}
      </div>
    </>
  )
}

interface PlayOutEmulatorsProps {
  status: EmulatorSetupStatus | null
  running: boolean
  /** The run going on is Update all emulators. */
  updating: boolean
  /** What the setup is doing right now (the bottom bar's text); null when idle. */
  progressLabel: string | null
  onSetup: () => void
  /** Update all emulators. */
  onUpdate: () => void
  onOpen: (path: string) => void
}

/** Where PlayOut installs its own emulators, the BIOS folder they all read, and the Set up emulators button. */
function PlayOutEmulators({
  status,
  running,
  updating,
  progressLabel,
  onSetup,
  onUpdate,
  onOpen
}: PlayOutEmulatorsProps): ReactElement {
  const t = useT()
  const pending = status?.items.filter((i) => i.state === 'missing' || i.state === 'failed') ?? []
  const failed = status?.items.filter((i) => i.state === 'failed') ?? []
  const installed = status?.items.filter((i) => i.state === 'installed').length ?? 0
  const report = status?.lastUpdate ? updateReportLines(status.lastUpdate) : []
  return (
    <div className="section">
      <div className="section__title">{t('settingsEmulators.playout.title')}</div>
      {status === null ? (
        <Spinner label={t('settingsEmulators.playout.reading')} className="settings-spinner" />
      ) : (
        <>
          <div className="settings-row">
            <span className="control__icon">
              <HardDrive />
            </span>
            <div className="settings-row__text">
              <span className="settings-row__label">
                {t('settingsEmulators.playout.installedIn')}
              </span>
              <span className="settings-row__value" title={status.root}>
                {shortPath(status.root)}
              </span>
              <span className="settings-row__desc">
                {running
                  ? (progressLabel ?? t('settingsEmulators.playout.settingUp'))
                  : t('settingsEmulators.playout.installedCount', {
                      installed,
                      total: status.items.length
                    })}
              </span>
            </div>
            <div className="settings-row__actions">
              {(running && !updating) || (!running && pending.length > 0) ? (
                <Button
                  focusKey={fk(SECTION, 'setup')}
                  variant="primary"
                  icon={running ? <Spinner size="sm" /> : <Download />}
                  disabled={running}
                  onPress={onSetup}
                >
                  {running
                    ? t('settingsEmulators.playout.setupRunning')
                    : t('settingsEmulators.playout.setup')}
                </Button>
              ) : null}
              <Button
                focusKey={fk(SECTION, 'setup-root')}
                icon={<FolderOpen />}
                onPress={() => onOpen(status.root)}
              >
                {t('settingsEmulators.playout.open')}
              </Button>
            </div>
          </div>
          <div className="settings-row">
            <span className="control__icon">
              <KeyRound />
            </span>
            <div className="settings-row__text">
              <span className="settings-row__label">
                {t('settingsEmulators.playout.bios.label')}
              </span>
              <span className="settings-row__value" title={status.biosDir}>
                {shortPath(status.biosDir)}
              </span>
              <span className="settings-row__desc">
                {t('settingsEmulators.playout.bios.description')}
              </span>
            </div>
            <div className="settings-row__actions">
              <Button
                focusKey={fk(SECTION, 'setup-bios')}
                icon={<FolderOpen />}
                onPress={() => onOpen(status.biosDir)}
              >
                {t('settingsEmulators.playout.open')}
              </Button>
            </div>
          </div>
          <div className="settings-row">
            <span className="control__icon">
              <RefreshCw />
            </span>
            <div className="settings-row__text">
              <span className="settings-row__label">
                {t('settingsEmulators.playout.update.label')}
              </span>
              <span className="settings-row__desc">
                {installed === 0
                  ? t('settingsEmulators.playout.update.first')
                  : t('settingsEmulators.playout.update.description')}
              </span>
            </div>
            <div className="settings-row__actions">
              <Button
                focusKey={fk(SECTION, 'update-all')}
                variant="secondary"
                icon={
                  updating ? (
                    <Spinner size="sm" />
                  ) : installed === 0 ? (
                    <RefreshCwOff />
                  ) : (
                    <RefreshCw />
                  )
                }
                disabled={running || installed === 0}
                onPress={onUpdate}
              >
                {updating
                  ? t('settingsEmulators.playout.update.running')
                  : t('settingsEmulators.playout.update.button')}
              </Button>
            </div>
          </div>
          {!running && report.length > 0 ? (
            <ul
              className="settings-update-report"
              aria-label={t('settingsEmulators.playout.update.reportLabel')}
            >
              {report.map((line) => (
                <li
                  key={line.id}
                  className={cx(
                    'settings-update-report__item',
                    line.tone === 'warn' && 'settings-update-report__item--warn'
                  )}
                >
                  <span className="settings-update-report__name">{line.name}</span>
                  <span className="settings-update-report__text">{line.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {running
            ? null
            : failed.map((item) => (
                <p key={item.id} className="settings-note settings-note--missing" role="status">
                  {item.error
                    ? t('settingsEmulators.playout.failedWithError', {
                        name: item.name,
                        error: item.error
                      })
                    : t('settingsEmulators.playout.failed', { name: item.name })}
                </p>
              ))}
          {status.notices.map((notice) => (
            <p key={notice} className="settings-note settings-note--missing" role="status">
              {notice}
            </p>
          ))}
        </>
      )}
    </div>
  )
}
