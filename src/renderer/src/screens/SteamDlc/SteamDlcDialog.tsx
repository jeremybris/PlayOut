import type { SteamDlcInfo } from '@shared/types'
import { ExternalLink } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { Spinner } from '../../components/Spinner'
import { Toggle } from '../../components/Toggle'
import { useT } from '../../i18n'
import { setFocus } from '../../input/focus'
import { displayTitle } from '../../lib/library'
import { createLog } from '../../lib/log'
import { useGame, useLibraryStore } from '../../state/library'
import {
  choiceChanged,
  choosableDlc,
  disabledFrom,
  dlcDescription,
  initialChoice,
  installSteamGame
} from '../../state/steamDlc'
import { useUiStore } from '../../state/ui'
import './steamDlc.css'

const log = createLog('steam-dlc')

const KEY = 'steam-dlc'
const KEYS = {
  allOn: `${KEY}:all-on`,
  allOff: `${KEY}:all-off`,
  dlc: (appId: number) => `${KEY}:dlc:${appId}`,
  primary: `${KEY}:primary`,
  cancel: `${KEY}:cancel`,
  steam: `${KEY}:steam`,
  retry: `${KEY}:retry`
} as const

/** All on / All off show from this many DLC that can be switched. */
export const QUICK_ACTIONS_FROM = 4

export interface SteamDlcDialogProps {
  gameId: string
  mode: 'install' | 'manage'
  onClose: () => void
}

/** The list as read: `n` is the load it answers (the dialog's `load` counter), so a reload shows its spinner. */
interface Loaded {
  n: number
  info: SteamDlcInfo | null
  /** api.steamDlc failed outright (the IPC call, not the list: that is `info.error`). */
  failed?: string
}

/**
 * A Steam game's DLC with a switch each (main steam-dlc/). 'install': chosen before the install; Steam installs the
 * game with every owned DLC and, once it finishes, PlayOut closes and reopens Steam once to remove the DLC turned off.
 * A game without DLC to choose installs straight away (the dialog only shows its spinner). 'manage': the installed
 * game's DLC as Steam has them; Apply closes and reopens Steam (never during a game; main says why it cannot).
 * Steam's own page ("Open in Steam") is always offered, and is the only way for opt-in / game-managed DLC.
 */
export function SteamDlcDialog({ gameId, mode, onClose }: SteamDlcDialogProps): ReactElement {
  const game = useGame(gameId)
  const toast = useUiStore((s) => s.toast)
  const t = useT()
  const title = game ? displayTitle(game) : t('steamDlc.thisGame')

  const [load, setLoad] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .steamDlc(gameId)
      .then((info) => {
        if (cancelled) return
        // Install: nothing to choose (no DLC, or only Steam-only ones) installs straight away.
        if (mode === 'install' && !info.error && choosableDlc(info).length === 0) {
          const current = useLibraryStore.getState().byId.get(gameId)
          if (current) void installSteamGame(current, [])
          onClose()
          return
        }
        setLoaded({ n: load, info })
      })
      .catch((err) => {
        log.error('steamDlc failed', err)
        if (!cancelled) setLoaded({ n: load, info: null, failed: t('steamDlc.readFailed') })
      })
    return () => {
      cancelled = true
    }
    // onClose is the host's stable close for this modal; only a new load re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, mode, load])

  // A re-read after Apply keeps the list on screen (Apply waits for it); Try again after an error shows the spinner.
  const refreshing = !!loaded && loaded.n !== load
  const lastError = loaded?.failed ?? loaded?.info?.error ?? null
  const loading = !loaded || (refreshing && !!lastError)
  const info = loaded?.info ?? null
  const error = loading ? null : lastError

  // The switches follow each list read (state adjusted during render when a new list arrives).
  const [choice, setChoice] = useState<{
    info: SteamDlcInfo | null
    on: Record<number, boolean>
  }>({ info: null, on: {} })
  if (info !== choice.info) setChoice({ info, on: info ? initialChoice(info, mode) : {} })
  const on = choice.on

  const switchable = choosableDlc(info)
  const ready = !loading && !error && !!info
  const firstKey =
    switchable.length >= QUICK_ACTIONS_FROM
      ? KEYS.allOn
      : switchable[0]
        ? KEYS.dlc(switchable[0].appId)
        : null
  // Focus the list once it shows (the footer had it while loading).
  useEffect(() => {
    if (ready && firstKey) void setFocus(firstKey)
    // only when the list (re)appears
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, loaded])

  const setOne = (appId: number, value: boolean): void => {
    setApplyError(null)
    setChoice((c) => ({ ...c, on: { ...c.on, [appId]: value } }))
  }
  const setAll = (value: boolean): void => {
    setApplyError(null)
    setChoice((c) => {
      const next = { ...c.on }
      for (const d of switchable) next[d.appId] = value
      return { ...c, on: next }
    })
  }

  const openInSteam = (): void => {
    api.openSteamDlcPage(gameId).catch((err) => {
      log.error('openSteamDlcPage failed', err)
      toast(t('steamDlc.openSteamFailed'), 'error')
    })
  }

  const install = (disabled: number[]): void => {
    onClose()
    if (game) void installSteamGame(game, disabled)
  }

  const apply = (): void => {
    if (!info || busy) return
    setBusy(true)
    setApplyError(null)
    api
      .setSteamDlc(gameId, disabledFrom(info, on))
      .then((result) => {
        if (!result.ok) {
          setApplyError(result.error ?? t('steamDlc.steamApplyFailed'))
          return
        }
        toast(
          result.planned ? t('steamDlc.savedForInstall', { title }) : t('steamDlc.applying'),
          'success'
        )
        setLoad((n) => n + 1)
      })
      .catch((err) => {
        log.error('setSteamDlc failed', err)
        setApplyError(t('steamDlc.applyFailed'))
      })
      .finally(() => setBusy(false))
  }

  const changed = ready && mode === 'manage' && choiceChanged(info, on)
  // Manage DLC needs Steam's install record of the game (its appmanifest); without one only Steam's page can help.
  const blocked =
    mode === 'manage'
      ? (info?.blocked ??
        (info && !info.installed ? t('steamDlc.noInstallRecord', { title }) : null))
      : null
  const ownershipUnknown = !!info?.dlc.some((d) => d.owned === null)

  const steamButton = (
    <Button focusKey={KEYS.steam} variant="ghost" icon={<ExternalLink />} onPress={openInSteam}>
      {t('steamDlc.openInSteam')}
    </Button>
  )
  const footer = loading ? (
    <Button focusKey={KEYS.cancel} onPress={onClose}>
      {t('steamDlc.cancel')}
    </Button>
  ) : error ? (
    <>
      {steamButton}
      <Button focusKey={KEYS.retry} onPress={() => setLoad((n) => n + 1)}>
        {t('steamDlc.tryAgain')}
      </Button>
      {mode === 'install' ? (
        <>
          <Button focusKey={KEYS.cancel} onPress={onClose}>
            {t('steamDlc.cancel')}
          </Button>
          <Button focusKey={KEYS.primary} variant="primary" onPress={() => install([])}>
            {t('steamDlc.installAnyway')}
          </Button>
        </>
      ) : (
        <Button focusKey={KEYS.cancel} onPress={onClose}>
          {t('steamDlc.close')}
        </Button>
      )}
    </>
  ) : mode === 'install' ? (
    <>
      {steamButton}
      <Button focusKey={KEYS.cancel} onPress={onClose}>
        {t('steamDlc.cancel')}
      </Button>
      <Button
        focusKey={KEYS.primary}
        variant="primary"
        onPress={() => info && install(disabledFrom(info, on))}
      >
        {t('steamDlc.install')}
      </Button>
    </>
  ) : (
    <>
      {steamButton}
      <Button focusKey={KEYS.cancel} onPress={onClose}>
        {t('steamDlc.close')}
      </Button>
      <Button
        focusKey={KEYS.primary}
        variant="primary"
        disabled={!changed || !!blocked || busy || refreshing}
        icon={busy ? <Spinner size="sm" /> : undefined}
        onPress={apply}
      >
        {busy
          ? t('steamDlc.applyingButton')
          : info?.steamRunning
            ? t('steamDlc.applyAndRestart')
            : t('steamDlc.apply')}
      </Button>
    </>
  )

  return (
    <Modal
      size="dialog"
      focusKey={KEY}
      preferredChildFocusKey={error ? (mode === 'install' ? KEYS.primary : KEYS.retry) : undefined}
      className="steam-dlc"
      title={
        mode === 'install'
          ? t('steamDlc.titleInstall', { title })
          : t('steamDlc.titleManage', { title })
      }
      onClose={onClose}
      footer={footer}
    >
      {loading ? (
        <Spinner label={t('steamDlc.reading')} className="steam-dlc__status" />
      ) : error ? (
        <p className="dialog__message">
          {error} {mode === 'install' ? t('steamDlc.errorInstall') : t('steamDlc.errorManage')}
        </p>
      ) : info ? (
        <>
          <p className="dialog__message">
            {mode === 'install'
              ? t('steamDlc.introInstall')
              : info.steamRunning
                ? t('steamDlc.introManageRestart')
                : t('steamDlc.introManage')}
          </p>
          {ownershipUnknown ? (
            <p className="steam-dlc__note">{t('steamDlc.ownershipUnknown')}</p>
          ) : null}
          {switchable.length >= QUICK_ACTIONS_FROM ? (
            <div className="steam-dlc__quick">
              <Button focusKey={KEYS.allOn} onPress={() => setAll(true)}>
                {t('steamDlc.allOn')}
              </Button>
              <Button focusKey={KEYS.allOff} onPress={() => setAll(false)}>
                {t('steamDlc.allOff')}
              </Button>
            </div>
          ) : null}
          {info.dlc.length ? (
            <div className="steam-dlc__list" role="group" aria-label={t('steamDlc.listLabel')}>
              {info.dlc.map((d) => (
                <Toggle
                  key={d.appId}
                  focusKey={KEYS.dlc(d.appId)}
                  label={d.name}
                  description={dlcDescription(d, mode)}
                  checked={on[d.appId] ?? d.enabled}
                  disabled={d.steamOnly}
                  onChange={(value) => setOne(d.appId, value)}
                />
              ))}
            </div>
          ) : (
            <p className="steam-dlc__note">{t('steamDlc.noDlc')}</p>
          )}
          {info.notOwnedCount > 0 ? (
            <p className="steam-dlc__note">
              {t('steamDlc.notOwned', { count: info.notOwnedCount })}
            </p>
          ) : null}
          {blocked ? <p className="steam-dlc__note steam-dlc__note--warn">{blocked}</p> : null}
          {applyError ? (
            <p className="steam-dlc__note steam-dlc__note--error" role="alert">
              {applyError}
            </p>
          ) : null}
        </>
      ) : null}
    </Modal>
  )
}
