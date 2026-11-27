import { recompInPlaceOf } from '@shared/recomp-play'
import type { Game, StorageDrive } from '@shared/types'
import { ArrowBigUp, HardDrive, RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { api } from '../../../api/client'
import { Button } from '../../../components/Button'
import { Spinner } from '../../../components/Spinner'
import { useT } from '../../../i18n'
import { formatBytes } from '../../../lib/format'
import { displayTitle } from '../../../lib/library'
import { storeNameOf } from '../../../lib/platforms'
import { canDeleteLocally, startLocalDelete } from '../../../state/localDelete'
import { useLibraryStore } from '../../../state/library'
import { useSystemStore } from '../../../state/system'
import { useUiStore } from '../../../state/ui'
import { fk, log } from '../common'
import { storageGames, storageTotals } from './storageView'
import './storage.css'

const SECTION = 'storage'

/**
 * Settings › Storage: what the games on this PC take on disk against the PC's drives. A bar (like a console's storage
 * screen) shows the games, everything else ("Other": the drives' size minus their free space minus the games, never
 * scanned) and the free space; below it every game on this PC, largest first, each with Delete.
 */
export function StorageSection(): ReactElement {
  const t = useT()
  const games = useLibraryStore((s) => s.games)
  const platformsById = useLibraryStore((s) => s.platformsById)
  const runningId = useSystemStore((s) => s.running?.gameId ?? null)
  const openModal = useUiStore((s) => s.openModal)
  const [drives, setDrives] = useState<StorageDrive[] | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(() => {
    api
      .getStorageDrives()
      .then((next) => {
        // No drive at all means Windows could not be asked: shown as a failure (Try again), not as an empty PC.
        if (next.length === 0) throw new Error('no drives reported')
        setDrives(next)
        setFailed(false)
      })
      .catch((err) => {
        log.error('getStorageDrives failed', err)
        setFailed(true)
      })
  }, [])
  // Read again when the library changes (a game deleted or installed frees or takes space).
  useEffect(load, [load, games])

  const list = useMemo(() => storageGames(games), [games])
  const totals = useMemo(() => (drives ? storageTotals(drives, list) : null), [drives, list])

  const where = (game: Game): string =>
    game.source === 'rom'
      ? (platformsById.get(game.platformId)?.name ?? 'ROM')
      : (storeNameOf(game.source) ?? 'PC')

  return (
    <div className="section">
      <div className="section__title">{t('settingsStorage.title')}</div>
      {failed ? (
        <p className="settings-note">
          {t('settingsStorage.readFailed')}{' '}
          <Button
            focusKey={fk(SECTION, 'retry')}
            variant="ghost"
            icon={<RotateCcw />}
            onPress={load}
          >
            {t('settingsStorage.tryAgain')}
          </Button>
        </p>
      ) : !totals ? (
        <Spinner label={t('settingsStorage.reading')} />
      ) : (
        <div className="storage">
          <div className="storage__head">
            <span className="storage__name">
              {drives && drives.length > 1
                ? t('settingsStorage.thisPcDrives', {
                    drives: drives.map((d) => d.root.replace(/\\$/, '')).join(', ')
                  })
                : t('settingsStorage.thisPc')}
            </span>
            <span className="storage__size">
              {t('settingsStorage.size', { size: formatBytes(totals.total) })}
            </span>
          </div>
          <div
            className="storage__bar"
            role="img"
            aria-label={t('settingsStorage.barLabel', {
              games: formatBytes(totals.games),
              other: formatBytes(totals.other),
              free: formatBytes(totals.free)
            })}
          >
            <span
              className="storage__seg storage__seg--games"
              style={{ width: `${totals.gamesShare * 100}%` }}
            />
            <span
              className="storage__seg storage__seg--other"
              style={{ width: `${totals.otherShare * 100}%` }}
            />
          </div>
          <div className="storage__free">
            {t('settingsStorage.free', { size: formatBytes(totals.free) })}
          </div>
          <div className="storage__legend">
            <div className="storage__legend-row">
              <span className="storage__dot storage__dot--games" />
              <span className="storage__legend-label">{t('settingsStorage.games')}</span>
              <span className="storage__legend-value">{formatBytes(totals.games)}</span>
            </div>
            <div className="storage__legend-row">
              <span className="storage__dot storage__dot--other" />
              <span className="storage__legend-label">{t('settingsStorage.other')}</span>
              <span className="storage__legend-value">{formatBytes(totals.other)}</span>
            </div>
          </div>
        </div>
      )}

      <div className="section__title storage__list-title">
        {t('settingsStorage.listTitle', { count: list.length })}
      </div>
      {list.length === 0 ? (
        <p className="settings-note">{t('settingsStorage.none')}</p>
      ) : (
        <div className="storage__games" role="list">
          {list.map(({ game, bytes, estimate }) => {
            const deletable = canDeleteLocally(game, { runningId })
            // Played from its recompilation (its disc image gone): its files are the recompilation's, deleted on the
            // game's Recompilation page.
            const recomp = recompInPlaceOf(game)
            const title = displayTitle(game)
            return (
              <div key={game.id} className="settings-row storage__game" role="listitem">
                <span className="control__icon">
                  <HardDrive />
                </span>
                <div className="settings-row__text">
                  <span className="settings-row__label">{title}</span>
                  <span className="settings-row__desc">{where(game)}</span>
                </div>
                <span className="storage__game-size">
                  {bytes === null
                    ? '—'
                    : estimate
                      ? t('settingsStorage.about', { size: formatBytes(bytes) })
                      : formatBytes(bytes)}
                </span>
                <div className="settings-row__actions">
                  {recomp ? (
                    <Button
                      focusKey={fk(SECTION, `delete:${game.id}`)}
                      variant="ghost"
                      icon={<ArrowBigUp />}
                      aria-label={t('settingsStorage.openRecomp', { title })}
                      onPress={() =>
                        openModal({ type: 'recomp', gameId: game.id, recompId: recomp })
                      }
                    >
                      {t('settingsStorage.recomp')}
                    </Button>
                  ) : (
                    <Button
                      focusKey={fk(SECTION, `delete:${game.id}`)}
                      variant="ghost"
                      icon={<Trash2 />}
                      aria-label={t('settingsStorage.deleteLabel', { title })}
                      disabled={!deletable}
                      onPress={() => void startLocalDelete(game)}
                    >
                      {t('settingsStorage.delete')}
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
