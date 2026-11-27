import { recompAchievementsFor } from '@shared/recomp-play'
import { EPIC_ACHIEVEMENTS_SOURCE, storeAchievementsSource } from '@shared/store-achievements'
import type { AchievementsInfo, AchievementsProvider, Game } from '@shared/types'
import { ExternalLink, Lock, Settings as SettingsIcon, Trophy } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Spinner } from '../../components/Spinner'
import { useActionHandlers } from '../../hooks/useActionHandlers'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useT } from '../../i18n'
import { setFocus } from '../../input/focus'
import { cx } from '../../lib/cx'
import { formatDate, formatPercent } from '../../lib/format'
import { createLog } from '../../lib/log'
import { retroSignedIn, useRetroAchievementsStatus } from '../../state/retroachievements'
import { useUiStore } from '../../state/ui'
import { achievementsStat, isHostRom, providerLink } from './achievements-stat'

const log = createLog('achievements')

export interface AchievementsListProps {
  game: Game
  /** Focus key to return to when the list closes (the ACHIEVEMENTS stat). */
  returnFocusKey: string
  onClose: () => void
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; info: AchievementsInfo }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }

/** The service a list comes from, as its header names it. */
const PROVIDER_NAMES: Record<Exclude<AchievementsProvider, 'recomp'>, string> = {
  steam: 'Steam',
  retroachievements: 'RetroAchievements',
  gog: 'GOG',
  epic: 'Epic Games'
}

/** The provider's name for the header and its link; null for a recompilation's own list. */
function providerName(info: AchievementsInfo): string | null {
  const provider = info.provider ?? 'steam'
  return provider === 'recomp' ? null : PROVIDER_NAMES[provider]
}

/** A load result remembers which game it belongs to, so switching games shows "loading" without a reset effect. */
type Loaded = { gameId: string; state: Exclude<LoadState, { status: 'loading' }> }

/**
 * Achievement list that replaces the description block while expanded (design 6.8). Loads lazily from
 * api.getAchievements: Steam for store games, RetroAchievements for ROMs, the recompilation's own for a game Play
 * starts a recompilation of whose achievements PlayOut reads (gamerscore, unlock dates from its unlock file). A null
 * result points to the sign-in the game needs (Steam account or key; the RetroAchievements account in Settings >
 * Emulators; for a paired host's ROM too, since this PC's account reads it), for a GOG or Epic game to its store's sign-in, or for a
 * recompilation to playing it once. The header names the service the list came from, with a link to its page.
 * Rows are focusable so the gamepad can scroll the list; B collapses it.
 */
export function AchievementsList({
  game,
  returnFocusKey,
  onClose
}: AchievementsListProps): ReactElement {
  const t = useT()
  const openModal = useUiStore((s) => s.openModal)
  // The recompilation's own achievements (the one Play starts), or RetroAchievements' for a ROM (achievements-stat.ts).
  const isRom = achievementsStat(game).label === 'retro'
  const recomp = !game.remote && recompAchievementsFor(game) !== null
  // A rejected key counts as signed out: the fix is in Settings, not in the ROM.
  const retroStatus = useRetroAchievementsStatus()
  const retroReady = retroSignedIn(retroStatus)
  // A paired host's game: its list is the host's (its accounts), so this PC's sign-in would not help; except a host's
  // ROM file, which this PC's RetroAchievements account reads first.
  const hostGame = !!game.remote
  const hostRomSignIn = isHostRom(game) && isRom && !retroReady
  const store = hostGame ? null : storeAchievementsSource(game)
  // The unavailable message offers a settings button when signing in would help.
  const settingsHint =
    !recomp &&
    ((!hostGame && game.source === 'steam') ||
      (isRom && !retroReady && (!hostGame || hostRomSignIn)))
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const state = useMemo<LoadState>(
    () => (loaded && loaded.gameId === game.id ? loaded.state : { status: 'loading' }),
    [loaded, game.id]
  )

  useEffect(() => {
    let cancelled = false
    const gameId = game.id
    api
      .getAchievements(gameId)
      .then((info) => {
        if (cancelled) return
        setLoaded({ gameId, state: info ? { status: 'ready', info } : { status: 'unavailable' } })
      })
      .catch((err) => {
        log.error('getAchievements failed', err)
        if (!cancelled) setLoaded({ gameId, state: { status: 'error', message: String(err) } })
      })
    return () => {
      cancelled = true
    }
  }, [game.id])

  // Move focus into the list once rows exist; otherwise onto the hint button or back to the stat. Only a new load
  // result (or the hint button appearing or going) moves it: a status change while rows show must not.
  const hintShown = state.status === 'unavailable' && settingsHint
  useEffect(() => {
    if (state.status === 'loading') return
    const target =
      state.status === 'ready' && state.info.list.length > 0
        ? 'detail:ach:0'
        : hintShown
          ? 'detail:ach:settings'
          : returnFocusKey
    void setFocus(target)
  }, [state, hintShown, returnFocusKey])

  const close = (): void => {
    onClose()
    void setFocus(returnFocusKey)
  }
  // Registered after the Modal's own back handler, so B collapses the list before it would close the panel.
  useActionHandlers({
    back: () => {
      close()
      return true
    }
  })

  const unlocked =
    state.status === 'ready' ? state.info.unlocked : (game.metadata.achievements?.unlocked ?? 0)
  const total =
    state.status === 'ready' ? state.info.total : (game.metadata.achievements?.total ?? 0)
  const points = state.status === 'ready' ? state.info.points : undefined
  const gamerscore = state.status === 'ready' && state.info.provider === 'recomp'
  const provider = state.status === 'ready' ? providerName(state.info) : null
  const providerUrl = state.status === 'ready' ? providerLink(state.info) : undefined

  return (
    <section className="gdetail__achievements" aria-label={t('gameDetail.achievements.title')}>
      <header className="gdetail__ach-header">
        <Trophy className="gdetail__ach-trophy" aria-hidden="true" />
        <span className="gdetail__ach-title">
          {isRom ? 'RetroAchievements' : t('gameDetail.achievements.title')}
        </span>
        {provider && !isRom ? <span className="gdetail__ach-provider">{provider}</span> : null}
        {total > 0 ? (
          <>
            <span className="gdetail__ach-count u-tabular">
              {unlocked}/{total}
            </span>
            <span className="gdetail__ach-percent">{formatPercent((unlocked / total) * 100)}</span>
            {points && points.total > 0 ? (
              <span className="gdetail__ach-points u-tabular">
                {t(
                  gamerscore
                    ? 'gameDetail.achievements.gamerscore'
                    : 'gameDetail.achievements.points',
                  { earned: points.earned, total: points.total }
                )}
              </span>
            ) : null}
            <span className="gdetail__ach-progress" aria-hidden="true">
              <span
                className="gdetail__ach-progress-fill"
                style={{ width: `${Math.min(100, (unlocked / total) * 100)}%` }}
              />
            </span>
          </>
        ) : null}
      </header>
      <div className="gdetail__ach-body">
        {state.status === 'loading' ? (
          <Spinner label={t('gameDetail.achievements.loading')} className="gdetail__ach-status" />
        ) : state.status === 'error' ? (
          <p className="gdetail__ach-status gdetail__ach-status--error">
            {t('gameDetail.achievements.loadFailed', { message: state.message })}
          </p>
        ) : state.status === 'unavailable' ? (
          <div className="gdetail__ach-status">
            {hostGame && !hostRomSignIn ? (
              <p>
                {game.remote?.hostName
                  ? t('gameDetail.achievements.hostNone', { host: game.remote.hostName })
                  : t('gameDetail.achievements.hostNoneUnknown')}
              </p>
            ) : recomp ? (
              <p>{t('gameDetail.achievements.recompPlayOnce')}</p>
            ) : game.source === 'steam' ? (
              <>
                <p>{t('gameDetail.achievements.steamNone')}</p>
                <Button
                  focusKey="detail:ach:settings"
                  icon={<SettingsIcon />}
                  onPress={() => openModal({ type: 'settings', section: 'metadata' })}
                >
                  {t('gameDetail.achievements.openMetadataSettings')}
                </Button>
              </>
            ) : store ? (
              <p>
                {t(
                  store === EPIC_ACHIEVEMENTS_SOURCE
                    ? 'gameDetail.achievements.epicNone'
                    : 'gameDetail.achievements.gogNone'
                )}
              </p>
            ) : isRom && !retroReady ? (
              <>
                <p>
                  {retroStatus?.state === 'invalid' || retroStatus?.state === 'error'
                    ? t('gameDetail.achievements.raCheckSettings', {
                        message: retroStatus.message ?? t('gameDetail.achievements.raNotSignedIn')
                      })
                    : t('gameDetail.achievements.raSignInHint')}
                </p>
                <Button
                  focusKey="detail:ach:settings"
                  icon={<SettingsIcon />}
                  onPress={() => openModal({ type: 'settings', section: 'emulators' })}
                >
                  {t('gameDetail.achievements.raSignIn')}
                </Button>
              </>
            ) : isRom ? (
              <p>{t('gameDetail.achievements.raUnknownRom')}</p>
            ) : (
              <p>{t('gameDetail.achievements.noData')}</p>
            )}
          </div>
        ) : state.info.list.length === 0 ? (
          <p className="gdetail__ach-status">
            {state.info.provider === 'recomp' && state.info.unlocked > 0
              ? t('gameDetail.achievements.recompCountOnly', { count: state.info.unlocked })
              : t('gameDetail.achievements.noneInGame')}
          </p>
        ) : (
          <ul className="gdetail__ach-list" role="list">
            {state.info.list.map((achievement, index) => (
              <AchievementRow
                key={achievement.id}
                index={index}
                achievement={achievement}
                gamerscore={gamerscore}
              />
            ))}
          </ul>
        )}
        {provider && providerUrl ? (
          <div className="gdetail__ach-link">
            <Button
              focusKey="detail:ach:link"
              icon={<ExternalLink />}
              onPress={() => {
                void api
                  .openExternal(providerUrl)
                  .catch((err) => log.error('openExternal failed', err))
              }}
            >
              {t('gameDetail.achievements.openProvider', { provider })}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

type Achievement = AchievementsInfo['list'][number]

function AchievementRow({
  index,
  achievement,
  gamerscore
}: {
  index: number
  achievement: Achievement
  /** Points are Xbox gamerscore ("25 G"). */
  gamerscore: boolean
}): ReactElement {
  const t = useT()
  const { ref, props: controlProps } = useFocusableControl<HTMLLIElement>({
    focusKey: `detail:ach:${index}`,
    scroll: { inline: 'nearest', block: 'nearest' }
  })
  const hiddenLocked = achievement.hidden && !achievement.unlocked
  return (
    <li
      ref={ref}
      className={cx('gdetail__ach-row', !achievement.unlocked && 'gdetail__ach-row--locked')}
      {...controlProps}
    >
      <span className="gdetail__ach-icon" aria-hidden="true">
        {achievement.icon ? (
          <img src={achievement.icon} alt="" draggable={false} />
        ) : achievement.unlocked ? (
          <Trophy />
        ) : (
          <Lock />
        )}
      </span>
      <span className="gdetail__ach-text">
        <span className="gdetail__ach-name">
          {hiddenLocked ? t('gameDetail.achievements.hidden') : achievement.name}
        </span>
        {achievement.description && !hiddenLocked ? (
          <span className="gdetail__ach-desc">{achievement.description}</span>
        ) : hiddenLocked ? (
          <span className="gdetail__ach-desc">{t('gameDetail.achievements.hiddenHint')}</span>
        ) : null}
      </span>
      <span className="gdetail__ach-when">
        {achievement.points !== undefined ? (
          <span className="gdetail__ach-pts u-tabular">
            {t(
              gamerscore ? 'gameDetail.achievements.gamerscorePts' : 'gameDetail.achievements.pts',
              {
                points: achievement.points
              }
            )}
          </span>
        ) : null}
        {achievement.unlocked
          ? (achievement.unlockedAt
              ? t('gameDetail.achievements.unlockedOn', {
                  date: formatDate(achievement.unlockedAt, 'medium')
                })
              : t('gameDetail.achievements.unlocked')) +
            (achievement.hardcore ? ` · ${t('gameDetail.achievements.hardcore')}` : '')
          : t('gameDetail.achievements.locked')}
      </span>
    </li>
  )
}
