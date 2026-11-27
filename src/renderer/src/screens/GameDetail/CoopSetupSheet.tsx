import type { CoopDevice, CoopLayout, CoopPlan, CoopSetup, Game } from '@shared/types'
import { FolderOpen, Gamepad2, RotateCcw, Trash2, Users } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { SelectField } from '../../components/SelectField'
import { Spinner } from '../../components/Spinner'
import {
  coopLayoutSummary,
  COOP_LAYOUT_LABELS,
  coopLayoutsFor,
  coopRiskNames
} from '../../lib/coop'
import { useT, type Translate } from '../../i18n'
import { displayTitle } from '../../lib/library'
import { createLog } from '../../lib/log'
import { startCoop } from '../../state/coop'
import { useLibraryStore } from '../../state/library'
import { useUiStore } from '../../state/ui'

const log = createLog('coop-setup')
const SHEET_KEY = 'coopsheet'
const AUTO = '*auto'

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** A short name for a device in the player rows ("Controller 2"; the full name is the row's description). */
function deviceLabel(t: Translate, device: CoopDevice): string {
  if (device.kind === 'xinput')
    return t('gameDetail.coop.controller', { number: (device.index ?? 0) + 1 })
  if (device.kind === 'keyboard') return t('gameDetail.coop.keyboardMouse')
  return device.name.length > 18 ? `${device.name.slice(0, 17)}…` : device.name
}

export interface CoopSetupSheetProps {
  game: Game
  onClose: () => void
}

/**
 * Co-Op setup (the separate customisation; Co-Op itself sets everything up automatically): which exe of the game the
 * handler runs, how many players, the screen layout and each player's controller. Every choice is saved with the game
 * (GameUserData.coop) at once; "Automatic" clears it. The plan shown is what Co-Op would do now.
 */
export function CoopSetupSheet({ game, onClose }: CoopSetupSheetProps): ReactElement {
  const t = useT()
  const applyGame = useLibraryStore((s) => s.applyGame)
  const toast = useUiStore((s) => s.toast)
  const [plan, setPlan] = useState<CoopPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [extracted, setExtracted] = useState(false)
  const setup = game.user.coop ?? {}

  // Loads without touching state first (the effect below runs it on mount); reload shows the spinner too.
  const load = useCallback(() => {
    api
      .getCoopPlan(game.id)
      .then(setPlan)
      .catch((err) => {
        log.warn('getCoopPlan failed', err)
        toast(t('gameDetail.coop.readFailed'), 'error')
      })
      .finally(() => setLoading(false))
    api
      .isCoopHandlerExtracted(game.id)
      .then(setExtracted)
      .catch(() => setExtracted(false))
  }, [game.id, toast, t])
  useEffect(load, [load])
  const reload = useCallback(() => {
    setLoading(true)
    load()
  }, [load])

  const save = useCallback(
    (next: CoopSetup | null) => {
      api
        .updateGame(game.id, { user: { coop: next } })
        .then((updated) => {
          applyGame(updated)
          reload()
        })
        .catch((err) => {
          log.error('updateGame failed', err)
          toast(t('gameDetail.coop.saveFailed'), 'error')
        })
    },
    [game.id, applyGame, reload, toast, t]
  )
  const change = (patch: Partial<CoopSetup>): void => {
    const next: CoopSetup = { ...setup, ...patch }
    for (const key of Object.keys(next) as (keyof CoopSetup)[])
      if (next[key] === undefined) delete next[key]
    save(Object.keys(next).length ? next : null)
  }

  const chooseExe = (): void => {
    api
      .chooseFile({
        title: t('gameDetail.coop.chooseExeTitle', { title: displayTitle(game) }),
        filters: [{ name: t('gameDetail.coop.programs'), extensions: ['exe'] }]
      })
      .then((file) => {
        if (file) change({ exePath: file })
      })
      .catch((err) => log.warn('chooseFile failed', err))
  }

  const removeHandler = (): void => {
    api
      .removeCoopHandler(game.id)
      .then(() => {
        setExtracted(false)
        toast(t('gameDetail.coop.handlerRemoved'))
      })
      .catch((err) => {
        log.error('removeCoopHandler failed', err)
        toast(t('gameDetail.coop.removeFailed'), 'error')
      })
  }

  const coop = game.metadata.coop
  const players = plan?.players ?? 0
  const maxPlayers = plan?.maxPlayers ?? coop?.maxPlayers ?? 4
  const deviceCount = plan?.devices.length ?? 0
  const playerChoices = Array.from(
    { length: Math.max(0, Math.min(maxPlayers, deviceCount) - 1) },
    (_, i) => i + 2
  )
  // A picked layout is each monitor's: with more monitors, layouts for each one's share of the players.
  const monitorCount = Math.max(1, plan?.screens.length ?? 1)
  const layouts = coopLayoutsFor(Math.max(Math.ceil(players / monitorCount), 2))
  const assigned = plan?.assigned ?? []

  const setDevice = (player: number, id: string): void => {
    if (!plan) return
    const order = [...assigned]
    if (id === AUTO) {
      change({ devices: undefined })
      return
    }
    // A device already given to another player trades places with this player's.
    const other = order.indexOf(id)
    if (other >= 0) order[other] = order[player]!
    order[player] = id
    change({ devices: order })
  }

  return createPortal(
    <Modal
      size="sheet"
      focusKey={SHEET_KEY}
      preferredChildFocusKey={`${SHEET_KEY}:play`}
      title={displayTitle(game)}
      subtitle={t('gameDetail.coop.subtitle')}
      onClose={onClose}
      aria-label={t('gameDetail.coop.label', { title: displayTitle(game) })}
      className="gsheet coopsheet"
    >
      <div className="gsheet__section">
        <div className="gsheet__title">Nucleus Co-Op</div>
        <p className="gsheet__note">
          {!coop
            ? t('gameDetail.coop.noHandler')
            : coop.maxPlayers
              ? t('gameDetail.coop.handlerMax', { name: coop.gameName, max: coop.maxPlayers })
              : t('gameDetail.coop.handler', { name: coop.gameName })}
        </p>
        {plan?.risks.length ? (
          <p className="gsheet__note coopsheet__warn">
            {t('gameDetail.coop.risks', { risks: coopRiskNames(plan.risks) })}
          </p>
        ) : null}
        {loading && !plan ? (
          <Spinner label={t('gameDetail.coop.readingControllers')} />
        ) : plan ? (
          <p
            className={plan.problem ? 'gsheet__note coopsheet__warn' : 'gsheet__note coopsheet__ok'}
          >
            {plan.problem ??
              t('gameDetail.coop.ready', {
                players: plan.players,
                layout: coopLayoutSummary(plan)
              })}
          </p>
        ) : null}
        <div className="coopsheet__actions">
          <Button
            focusKey={`${SHEET_KEY}:play`}
            variant="primary"
            icon={<Users />}
            disabled={!plan || !!plan.problem}
            onPress={() => {
              onClose()
              startCoop(game)
            }}
          >
            {t('gameDetail.coop.play')}
          </Button>
          <Button
            focusKey={`${SHEET_KEY}:refresh`}
            icon={loading ? <Spinner size="sm" /> : <Gamepad2 />}
            onPress={reload}
          >
            {t('gameDetail.coop.checkControllers')}
          </Button>
          <Button
            focusKey={`${SHEET_KEY}:reset`}
            variant="ghost"
            icon={<RotateCcw />}
            disabled={!game.user.coop || Object.keys(setup).every((k) => k === 'risksAccepted')}
            onPress={() => save(setup.risksAccepted ? { risksAccepted: true } : null)}
          >
            {t('gameDetail.coop.allAutomatic')}
          </Button>
        </div>
      </div>

      {plan ? (
        <div className="gsheet__section">
          <div className="gsheet__title">{t('gameDetail.coop.gameTitle')}</div>
          <SelectField
            focusKey={`${SHEET_KEY}:exe`}
            label={t('gameDetail.coop.gameExe')}
            description={plan.exePath ?? t('gameDetail.coop.notFound')}
            value={setup.exePath ?? AUTO}
            options={[
              { value: AUTO, label: t('gameDetail.coop.automatic') },
              ...[...new Set([...(setup.exePath ? [setup.exePath] : []), ...plan.exeChoices])].map(
                (p) => ({ value: p, label: fileName(p) })
              )
            ]}
            onChange={(value) => change({ exePath: value === AUTO ? undefined : value })}
          />
          <Button focusKey={`${SHEET_KEY}:browse`} icon={<FolderOpen />} onPress={chooseExe}>
            {t('gameDetail.coop.chooseExe')}
          </Button>
        </div>
      ) : null}

      {plan ? (
        <div className="gsheet__section">
          <div className="gsheet__title">{t('gameDetail.coop.playersTitle')}</div>
          <SelectField
            focusKey={`${SHEET_KEY}:players`}
            label={t('gameDetail.coop.players')}
            description={t('gameDetail.coop.playersNow', { players, count: deviceCount })}
            value={setup.players ? String(setup.players) : AUTO}
            options={[
              { value: AUTO, label: t('gameDetail.coop.automatic') },
              ...playerChoices.map((n) => ({ value: String(n), label: String(n) }))
            ]}
            onChange={(value) => change({ players: value === AUTO ? undefined : Number(value) })}
          />
          <SelectField
            focusKey={`${SHEET_KEY}:layout`}
            label={t('gameDetail.coop.layout')}
            description={t('gameDetail.coop.layoutNow', { layout: coopLayoutSummary(plan) })}
            value={setup.layout && layouts.includes(setup.layout) ? setup.layout : AUTO}
            options={[
              { value: AUTO, label: t('gameDetail.coop.automatic') },
              ...layouts.map((l) => ({ value: l, label: COOP_LAYOUT_LABELS[l] }))
            ]}
            onChange={(value) =>
              change({ layout: value === AUTO ? undefined : (value as CoopLayout) })
            }
          />
          {assigned.map((id, i) => (
            <SelectField
              key={i}
              focusKey={`${SHEET_KEY}:player:${i}`}
              label={t('gameDetail.coop.player', { number: i + 1 })}
              description={plan.devices.find((d) => d.id === id)?.name ?? id}
              value={setup.devices ? id : AUTO}
              options={[
                { value: AUTO, label: t('gameDetail.coop.automatic') },
                ...plan.devices.map((d) => ({ value: d.id, label: deviceLabel(t, d) }))
              ]}
              onChange={(value) => setDevice(i, value)}
            />
          ))}
        </div>
      ) : null}

      {extracted ? (
        <div className="gsheet__section">
          <div className="gsheet__title">{t('gameDetail.coop.handlerTitle')}</div>
          <Button
            focusKey={`${SHEET_KEY}:remove`}
            variant="ghost"
            icon={<Trash2 />}
            onPress={removeHandler}
          >
            {t('gameDetail.coop.removeHandler')}
          </Button>
          <p className="gsheet__note">{t('gameDetail.coop.handlerNote')}</p>
        </div>
      ) : null}
    </Modal>,
    document.body
  )
}
