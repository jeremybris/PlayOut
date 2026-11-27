import type { ImportResult, ScanProgress, ScanResult, SourceStatus } from '@shared/types'
import { Download, FolderOpen, FolderPlus, RefreshCw } from 'lucide-react'
import { useCallback, useState, type ReactElement } from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Chip } from '../../components/Chip'
import { Spinner } from '../../components/Spinner'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import { createLog } from '../../lib/log'
import { useUiStore } from '../../state/ui'
import { ScanLiveText } from './SourceCard'

const log = createLog('addgames:rom')

export interface RomFolderStepProps {
  /** settings.library.romsRoot: always the Emulation folder's roms folder (null only before settings load). */
  romsRoot: string | null
  /** The 'rom' entry from api.getSources(), when loaded. */
  source?: SourceStatus
  progress?: ScanProgress
  scanning: boolean
  /** ROM games already in the library (enables "Import ES-DE data"). */
  romGameCount: number
  /** Scan the ROM folder (the parent owns scanning state and toasts); resolves null when the scan failed. */
  onScan: () => Promise<ScanResult | null>
}

interface RomSummary {
  systems: { id: string; name: string; count: number }[]
  unknownFolders: string[]
  added: number
  updated: number
}

type Working = 'choose' | 'import' | null

/**
 * The "ROM folder" card: shows the ROM folder (the Emulation folder's roms folder), picks another Emulation folder
 * (chooseFolder -> settings -> scan), summarises the systems found and the unknown subfolders, and imports ES-DE
 * gamelists/media.
 */
export function RomFolderStep({
  romsRoot,
  source,
  progress,
  scanning,
  romGameCount,
  onScan
}: RomFolderStepProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const openModal = useUiStore((s) => s.openModal)
  const [working, setWorking] = useState<Working>(null)
  const [summary, setSummary] = useState<RomSummary | null>(null)
  const [imported, setImported] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rescan = useCallback(async (): Promise<void> => {
    setError(null)
    const result = await onScan()
    if (!result) return
    try {
      const systems = await api.getSystems()
      setSummary({
        systems: systems
          .filter((s) => s.gameCount > 0)
          .map((s) => ({ id: s.id, name: s.name, count: s.gameCount })),
        unknownFolders: result.unknownFolders ?? [],
        added: result.added,
        updated: result.updated
      })
    } catch (err) {
      log.error('getSystems failed', err)
      setError(t('addGames.rom.systemListFailed', { error: errorText(err) }))
    }
  }, [onScan, t])

  // The ROM folder is the Emulation folder's roms folder (main keeps it so): another Emulation folder moves the one in
  // use there (EmulationMoveDialog), then a scan.
  const chooseFolder = useCallback(async (): Promise<void> => {
    if (working || scanning) return
    setWorking('choose')
    setError(null)
    try {
      const folder = await api.chooseFolder(t('addGames.rom.chooseEmulation'))
      if (!folder) return
      openModal({
        type: 'emulation-move',
        request: { kind: 'choose', picked: folder },
        onDone: (dir) => {
          toast(t('addGames.rom.folderSet', { folder: dir }))
          setImported(null)
          void rescan()
        }
      })
    } catch (err) {
      log.error('choosing the Emulation folder failed', err)
      setError(errorText(err))
      toast(t('addGames.rom.setFailed'), 'error')
    } finally {
      setWorking(null)
    }
  }, [working, scanning, openModal, toast, rescan, t])

  const importEsde = useCallback(async (): Promise<void> => {
    if (working || scanning) return
    setWorking('import')
    setError(null)
    try {
      const result = await api.importEsde()
      setImported(result)
      if (result.gamesUpdated > 0) {
        toast(
          t('addGames.rom.imported', {
            count: result.gamesUpdated,
            images: t('addGames.rom.images', { count: result.mediaCopied })
          }),
          'success'
        )
      } else {
        toast(result.message ?? t('addGames.rom.nothingToImport'))
      }
    } catch (err) {
      log.error('importEsde failed', err)
      setError(errorText(err))
      toast(t('addGames.rom.importFailed'), 'error')
    } finally {
      setWorking(null)
    }
  }, [working, scanning, toast, t])

  const hasRoms = romGameCount > 0 || (source?.gameCount ?? 0) > 0

  return (
    <article
      className={cx('srccard', 'srccard--wide', scanning && 'srccard--scanning')}
      aria-label={t('addGames.rom.label')}
      aria-busy={scanning || working !== null || undefined}
    >
      <header className="srccard__head">
        <span className="srccard__icon" aria-hidden="true">
          <FolderOpen />
        </span>
        <div className="srccard__titles">
          <span className="srccard__name">{t('addGames.rom.label')}</span>
          <span
            className={cx('srccard__status', romsRoot && 'srccard__status--ok')}
            title={romsRoot ?? undefined}
          >
            {romsRoot ?? t('addGames.rom.loading')}
          </span>
        </div>
        {hasRoms ? (
          <Chip accent>
            {t('addGames.rom.roms', { count: Math.max(romGameCount, source?.gameCount ?? 0) })}
          </Chip>
        ) : null}
      </header>
      <div className="srccard__info">
        <span>{t('addGames.rom.info')}</span>
        {summary ? (
          <div className="romstep__summary">
            {summary.systems.length > 0 ? (
              <div className="romstep__systems">
                {summary.systems.map((s) => (
                  <Chip key={s.id} title={s.name}>
                    {s.name} · {s.count}
                  </Chip>
                ))}
              </div>
            ) : (
              <span>{t('addGames.rom.noRoms')}</span>
            )}
            <span>
              {t('addGames.rom.addedUpdated', { added: summary.added, updated: summary.updated })}
            </span>
            {summary.unknownFolders.length > 0 ? (
              <span className="romstep__unknown">
                {t('addGames.rom.unknownFolders', { folders: summary.unknownFolders.join(', ') })}
              </span>
            ) : null}
          </div>
        ) : null}
        {imported ? (
          <span>
            {imported.message ??
              t('addGames.rom.importSummary', {
                games: t('addGames.games', { count: imported.gamesUpdated }),
                images: t('addGames.rom.images', { count: imported.mediaCopied })
              })}
          </span>
        ) : null}
      </div>
      <footer className="srccard__foot">
        <Button
          focusKey="addgames:rom:choose"
          icon={working === 'choose' ? <Spinner size="sm" /> : <FolderPlus />}
          onPress={() => void chooseFolder()}
        >
          {t('addGames.rom.change')}
        </Button>
        {romsRoot ? (
          <Button
            focusKey="addgames:rom:scan"
            icon={scanning ? <Spinner size="sm" /> : <RefreshCw />}
            onPress={() => {
              if (!scanning && !working) void rescan()
            }}
          >
            {scanning ? t('addGames.scanning') : t('addGames.rom.scan')}
          </Button>
        ) : null}
        {hasRoms ? (
          <Button
            focusKey="addgames:rom:import"
            icon={working === 'import' ? <Spinner size="sm" /> : <Download />}
            onPress={() => void importEsde()}
          >
            {t('addGames.rom.importEsde')}
          </Button>
        ) : null}
        {scanning ? <ScanLiveText progress={progress} /> : null}
      </footer>
      {error ? <p className="srccard__error">{error}</p> : null}
    </article>
  )
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
