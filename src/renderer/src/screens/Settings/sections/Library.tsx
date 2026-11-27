import type { EmulationMoveRequest } from '@shared/emulation-move'
import type { HomeRowMode, ScanProgress, SourceId, SourceStatus } from '@shared/types'
import {
  Copy,
  Download,
  Eye,
  FolderTree,
  House,
  Package,
  RefreshCw,
  Save,
  Scissors
} from 'lucide-react'
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { api } from '../../../api/client'
import { Button } from '../../../components/Button'
import { PlatformBadge } from '../../../components/PlatformBadge'
import { SelectField } from '../../../components/SelectField'
import { Spinner } from '../../../components/Spinner'
import { Toggle } from '../../../components/Toggle'
import { useT, type Translate } from '../../../i18n'
import { formatRelativeDay } from '../../../lib/format'
import { useLibraryStore } from '../../../state/library'
import { useUiStore } from '../../../state/ui'
import { fk, log, type SectionProps } from '../common'
import { PathRow } from '../PathRow'
import { CoopSection } from '../CoopSection'
import { LibraryTabsSettings } from './Tabs'

const SECTION = 'library'

/** Two Windows paths name the same folder (case, slashes and a trailing separator ignored). */
function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  return !!a && !!b && norm(a) === norm(b)
}

/**
 * Settings > Library > Front page: what Home's row of games shows (settings.ui.homeRow), labelled in the current
 * language (built per render, never kept).
 */
function homeRowOptions(t: Translate): { value: HomeRowMode; label: string }[] {
  return [
    { value: 'recent', label: t('settingsLibrary.frontPage.options.recent') },
    { value: 'added', label: t('settingsLibrary.frontPage.options.added') },
    { value: 'favorites', label: t('settingsLibrary.frontPage.options.favorites') },
    { value: 'played', label: t('settingsLibrary.frontPage.options.played') }
  ]
}

type Progress = Record<string, ScanProgress | undefined>

/** A source's line under its toggle: scan under way, error, or its games, client version and last scan. */
function statusText(
  t: Translate,
  source: SourceStatus,
  progress: ScanProgress | undefined
): string {
  if (progress && (progress.phase === 'detecting' || progress.phase === 'scanning')) {
    return progress.phase === 'detecting'
      ? t('settingsLibrary.sources.status.detecting')
      : t('settingsLibrary.sources.status.scanning', { count: progress.found })
  }
  if (source.error) return t('settingsLibrary.sources.status.error', { error: source.error })
  const parts: string[] = []
  if (source.id === 'rom' || source.id === 'manual') {
    parts.push(t('settingsLibrary.sources.status.games', { count: source.gameCount }))
  } else if (source.client.installed) {
    parts.push(
      source.client.version
        ? t('settingsLibrary.sources.status.detectedVersion', { version: source.client.version })
        : t('settingsLibrary.sources.status.detected'),
      t('settingsLibrary.sources.status.games', { count: source.gameCount })
    )
  } else {
    parts.push(t('settingsLibrary.sources.status.notInstalled'))
  }
  if (source.lastScanAt)
    parts.push(
      t('settingsLibrary.sources.status.lastScan', { when: formatRelativeDay(source.lastScanAt) })
    )
  return parts.join(' · ')
}

/** Sources with enable toggles and Scan buttons, ROM / ES-DE folders, visibility toggles. */
export function LibrarySection({ settings, patch }: SectionProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const platformsById = useLibraryStore((s) => s.platformsById)
  const [sources, setSources] = useState<SourceStatus[] | null>(null)
  const [progress, setProgress] = useState<Progress>({})
  const [scanning, setScanning] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)

  const loadSources = useCallback(() => {
    api
      .getSources()
      .then(setSources)
      .catch((err) => {
        log.error('getSources failed', err)
        toast(t('settingsLibrary.toasts.sourcesFailed'), 'error')
      })
  }, [t, toast])
  useEffect(loadSources, [loadSources])

  useEffect(
    () =>
      api.on('scan:progress', (p) => {
        setProgress((prev) => ({ ...prev, [p.sourceId]: p }))
      }),
    []
  )

  const scan = useCallback(
    (ids?: SourceId[]) => {
      const key = ids ? ids.join(',') : 'all'
      setScanning((prev) => new Set(prev).add(key))
      api
        .scanSources(ids)
        .then((result) => {
          toast(
            t('settingsLibrary.toasts.scanFinished', {
              added: result.added,
              updated: result.updated,
              removed: result.removed
            }),
            'success'
          )
          setSources(result.sources)
        })
        .catch((err) => {
          log.error('scanSources failed', err)
          toast(t('settingsLibrary.toasts.scanFailed'), 'error')
          loadSources()
        })
        .finally(() => {
          setScanning((prev) => {
            const next = new Set(prev)
            next.delete(key)
            return next
          })
          setProgress({})
        })
    },
    [t, toast, loadSources]
  )

  const chooseEsde = useCallback(() => {
    api
      .chooseFolder(t('settingsLibrary.folders.esde.picker'))
      .then((folder) => {
        if (folder) patch({ library: { esdeHome: folder } })
      })
      .catch((err) => {
        log.error('chooseFolder failed', err)
        toast(t('settingsLibrary.toasts.folderPickerFailed'), 'error')
      })
  }, [patch, t, toast])

  // Changing the Emulation folder moves it (EmulationMoveDialog: what moves, its size, then the move). The ROM folder
  // is its roms folder (main keeps it so): once it changed, the ROMs are scanned again.
  const openModal = useUiStore((s) => s.openModal)
  const moveEmulation = useCallback(
    (request: EmulationMoveRequest) =>
      openModal({ type: 'emulation-move', request, onDone: () => scan(['rom']) }),
    [openModal, scan]
  )

  const chooseEmulation = useCallback(() => {
    api
      .chooseFolder(t('settingsLibrary.folders.emulation.picker'))
      .then((folder) => {
        if (folder) moveEmulation({ kind: 'choose', picked: folder })
      })
      .catch((err) => {
        log.error('chooseFolder failed', err)
        toast(t('settingsLibrary.toasts.folderPickerFailed'), 'error')
      })
  }, [moveEmulation, t, toast])

  // PlayOut's own Emulation folder, shown while no other is chosen (an older install's, in its data folder), and the
  // default Documents\Emulation, which the Default button moves the folder to.
  const [defaultEmulationDir, setDefaultEmulationDir] = useState<string | null>(null)
  const [documentsEmulationDir, setDocumentsEmulationDir] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api
      .getAppInfo()
      .then((info) => {
        if (!live) return
        const sep = info.userDataPath.includes('\\') ? '\\' : '/'
        setDefaultEmulationDir(`${info.userDataPath}${sep}Emulation`)
        if (info.documentsPath)
          setDocumentsEmulationDir(`${info.documentsPath.replace(/[\\/]+$/, '')}${sep}Emulation`)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  // Generate: an Emulation folder inside the folder the user picks; the one in use moves there (with every folder of
  // the layout it lacks made afterwards).
  const generate = useCallback(() => {
    api
      .chooseFolder(t('settingsLibrary.folders.emulation.generatePicker'))
      .then((folder) => {
        if (folder) moveEmulation({ kind: 'generate', picked: folder })
      })
      .catch((err) => {
        log.error('chooseFolder failed', err)
        toast(t('settingsLibrary.toasts.folderPickerFailed'), 'error')
      })
  }, [moveEmulation, t, toast])

  const importEsde = useCallback(() => {
    setImporting(true)
    api
      .importEsde()
      .then((result) => {
        // Two counts, each with its own plural, joined into one summary.
        const summary = t('settingsLibrary.toasts.esdeSummary', {
          games: t('settingsLibrary.toasts.esdeGamesUpdated', { count: result.gamesUpdated }),
          images: t('settingsLibrary.toasts.esdeImagesCopied', { count: result.mediaCopied })
        })
        toast(
          result.message
            ? t('settingsLibrary.toasts.esdeMessage', { message: result.message, summary })
            : t('settingsLibrary.toasts.esdeDone', { summary }),
          result.gamesUpdated > 0 || result.mediaCopied > 0 ? 'success' : 'info'
        )
      })
      .catch((err) => {
        log.error('importEsde failed', err)
        toast(t('settingsLibrary.toasts.esdeFailed'), 'error')
      })
      .finally(() => setImporting(false))
  }, [t, toast])

  const scanningAll = scanning.has('all')

  return (
    <>
      <div className="settings-section__header">
        <div>
          <h2 className="settings-section__title">{t('settingsLibrary.title')}</h2>
          <p className="settings-section__lead">{t('settingsLibrary.lead')}</p>
        </div>
        <Button
          focusKey={fk(SECTION, 'scanAll')}
          variant="primary"
          icon={scanningAll ? <Spinner size="sm" /> : <RefreshCw />}
          disabled={scanningAll}
          onPress={() => scan()}
        >
          {t('settingsLibrary.scanAll')}
        </Button>
      </div>

      <div className="section">
        <div className="section__title">{t('settingsLibrary.sources.title')}</div>
        {sources === null ? (
          <Spinner label={t('settingsLibrary.sources.detecting')} className="settings-spinner" />
        ) : (
          sources.map((source) => {
            const platform = platformsById.get(source.id)
            const busy = scanning.has(source.id) || scanningAll
            return (
              <div key={source.id} className="settings-row settings-row--source">
                <PlatformBadge
                  platform={platform}
                  icon={platform ? undefined : source.id}
                  name={source.name}
                  size="md"
                />
                <Toggle
                  className="settings-row__toggle"
                  focusKey={fk(SECTION, `source:${source.id}`)}
                  label={source.name}
                  description={statusText(t, source, progress[source.id])}
                  checked={settings.library.sources[source.id]?.enabled ?? true}
                  onChange={(enabled) =>
                    patch({
                      library: {
                        sources: { ...settings.library.sources, [source.id]: { enabled } }
                      }
                    })
                  }
                />
                <Button
                  focusKey={fk(SECTION, `scan:${source.id}`)}
                  icon={busy ? <Spinner size="sm" /> : <RefreshCw />}
                  disabled={busy || !(settings.library.sources[source.id]?.enabled ?? true)}
                  onPress={() => scan([source.id])}
                >
                  {t('settingsLibrary.sources.scan')}
                </Button>
              </div>
            )
          })
        )}
      </div>

      <div className="section">
        <div className="section__title">{t('settingsLibrary.folders.title')}</div>
        <PathRow
          focusKey={fk(SECTION, 'esde')}
          icon={<Package />}
          label={t('settingsLibrary.folders.esde.label')}
          description={t('settingsLibrary.folders.esde.description')}
          value={settings.library.esdeHome}
          placeholder={t('settingsLibrary.folders.esde.placeholder')}
          clearLabel={t('settingsLibrary.folders.esde.clear')}
          onChoose={chooseEsde}
          onClear={() => patch({ library: { esdeHome: null } })}
          extra={
            <Button
              focusKey={fk(SECTION, 'importEsde')}
              icon={importing ? <Spinner size="sm" /> : <Download />}
              disabled={importing}
              onPress={importEsde}
            >
              {t('settingsLibrary.folders.esde.import')}
            </Button>
          }
        />
        <PathRow
          focusKey={fk(SECTION, 'emulation')}
          icon={<FolderTree />}
          label={t('settingsLibrary.folders.emulation.label')}
          description={t('settingsLibrary.folders.emulation.description')}
          value={settings.library.emulationDir}
          placeholder={
            defaultEmulationDir
              ? t('settingsLibrary.folders.emulation.placeholderPath', {
                  path: defaultEmulationDir
                })
              : t('settingsLibrary.folders.emulation.placeholder')
          }
          clearLabel={t('settingsLibrary.folders.emulation.clear')}
          onGenerate={generate}
          onChoose={chooseEmulation}
          onClear={() => moveEmulation({ kind: 'default' })}
          // Default moves the folder in use (the setting's, else the older default) to Documents\Emulation: offered
          // whenever that is not the folder in use already.
          clearEnabled={
            !!documentsEmulationDir &&
            !samePath(settings.library.emulationDir || defaultEmulationDir, documentsEmulationDir)
          }
        />
        {/* PC Saves (main/pc-saves): each added game's save folder is chosen in its Edit sheet. */}
        <Toggle
          focusKey={fk(SECTION, 'copyPcSaves')}
          icon={<Save />}
          label={t('settingsLibrary.folders.copyPcSaves.label')}
          description={t('settingsLibrary.folders.copyPcSaves.description')}
          checked={settings.library.copyPcSaves}
          onChange={(v) => patch({ library: { copyPcSaves: v } })}
        />
      </div>

      <div className="section">
        <div className="section__title">{t('settingsLibrary.frontPage.title')}</div>
        <div className="settings-row">
          <span className="control__icon">
            <House />
          </span>
          <div className="settings-row__text">
            <span className="settings-row__label">{t('settingsLibrary.frontPage.label')}</span>
            <span className="settings-row__desc">{t('settingsLibrary.frontPage.description')}</span>
          </div>
          <div className="settings-row__actions">
            {/* A dropdown (the pill opens a list of the three), not a row that cycles. */}
            <SelectField
              focusKey={fk(SECTION, 'homeRow')}
              variant="pill"
              label={t('settingsLibrary.frontPage.label')}
              value={settings.ui.homeRow}
              options={homeRowOptions(t)}
              onChange={(v) => patch({ ui: { homeRow: v } })}
            />
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section__title">{t('settingsLibrary.visibility.title')}</div>
        <Toggle
          focusKey={fk(SECTION, 'showHidden')}
          icon={<Eye />}
          label={t('settingsLibrary.visibility.showHidden.label')}
          description={t('settingsLibrary.visibility.showHidden.description')}
          checked={settings.library.showHidden}
          onChange={(v) => patch({ library: { showHidden: v } })}
        />
        <Toggle
          focusKey={fk(SECTION, 'showUninstalled')}
          icon={<Package />}
          label={t('settingsLibrary.visibility.showUninstalled.label')}
          description={t('settingsLibrary.visibility.showUninstalled.description')}
          checked={settings.library.showUninstalled}
          onChange={(v) => patch({ library: { showUninstalled: v } })}
        />
        <Toggle
          focusKey={fk(SECTION, 'showDuplicates')}
          icon={<Copy />}
          label={t('settingsLibrary.visibility.showDuplicates.label')}
          description={t('settingsLibrary.visibility.showDuplicates.description')}
          checked={settings.library.showDuplicates}
          onChange={(v) => patch({ library: { showDuplicates: v } })}
        />
      </div>

      <div className="section">
        <div className="section__title">{t('settingsLibrary.newGames.title')}</div>
        <Toggle
          focusKey={fk(SECTION, 'trimGames')}
          icon={<Scissors />}
          label={t('settingsLibrary.newGames.trimGames.label')}
          description={t('settingsLibrary.newGames.trimGames.description')}
          checked={settings.library.trimGames}
          onChange={(v) => patch({ library: { trimGames: v } })}
        />
      </div>

      <CoopSection settings={settings} patch={patch} />

      <LibraryTabsSettings settings={settings} />
    </>
  )
}
