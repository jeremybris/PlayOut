// The Upgrade menu (the sparkles button right of Play, PC games only): the five upgrades main upgrades/ offers for an
// installed PC game. Turning one on for a game whose Steam tags or files say it has anti-cheat first warns about the
// ban risk; compressing always warns that it can lengthen loading.
import { ENABLING_ACTIONS, type UpgradeAction, type UpgradeStatus } from '@shared/upgrades'
import type { Game } from '@shared/types'
import { Archive, Cpu, FileCog, Layers, Sparkles, Undo2, X, Zap } from 'lucide-react'
import { useEffect, useState, type MouseEvent, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../api/client'
import { Menu, MenuItem } from '../../components/MenuItem'
import { Spinner } from '../../components/Spinner'
import { LayerContext, useActionHandlersOnLayer } from '../../hooks/useActionHandlers'
import { useFocusLayer } from '../../hooks/useFocusLayer'
import { useT, type Translate } from '../../i18n'
import { FocusContext } from '../../input/focus'
import { formatBytes, formatDate } from '../../lib/format'
import { displayTitle } from '../../lib/library'
import { createLog } from '../../lib/log'
import { blockedOnly, dllHint, shaderHint, stoppableUpgrade } from '../../lib/upgradeMenu'
import { useUiStore } from '../../state/ui'
import { startUpgradeProgress, useUpgradeProgress } from '../../state/upgrades'

const log = createLog('upgrademenu')

const MENU_FOCUS_KEY = 'upgrademenu'
/** Gap between the menu and the button (design units). */
const MENU_GAP_U = 12

export interface UpgradeMenuProps {
  game: Game
  anchor: HTMLElement
  onClose: () => void
}

/**
 * The ban-risk warning's text for a game, or null when nothing points to anti-cheat: the sentence naming what points
 * to it (its tags, files in its folder, or both: one whole sentence each), then what that risks.
 */
function riskWarning(t: Translate, status: UpgradeStatus, title: string): string | null {
  const { tags, antiCheat } = status.risk
  if (!tags.length && !antiCheat.length) return null
  const vars = { title, tags: tags.join(', '), files: antiCheat.join(', ') }
  const reason =
    tags.length && antiCheat.length
      ? t('gameDetail.upgrades.risk.reasonBoth', vars)
      : tags.length
        ? t('gameDetail.upgrades.risk.reasonTags', vars)
        : t('gameDetail.upgrades.risk.reasonAntiCheat', vars)
  return `${reason} ${t('gameDetail.upgrades.risk.consequence')}`
}

/** The Upgrade menu, anchored above the sparkles button. */
export function UpgradeMenu({ game, anchor, onClose }: UpgradeMenuProps): ReactElement {
  const t = useT()
  const openModal = useUiStore((s) => s.openModal)
  const toast = useUiStore((s) => s.toast)
  const progress = useUpgradeProgress(game.id)
  const [status, setStatus] = useState<UpgradeStatus | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [position, setPosition] = useState(() => place(anchor))

  const { ref, layerId } = useFocusLayer<HTMLDivElement>({
    focusKey: MENU_FOCUS_KEY,
    preferredChildFocusKey: `${MENU_FOCUS_KEY}:dlls`
  })
  useActionHandlersOnLayer(layerId, {
    back: () => {
      onClose()
      return true
    }
  })

  useEffect(startUpgradeProgress, [])
  useEffect(() => {
    const update = (): void => setPosition(place(anchor))
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [anchor])

  // The status, read again whenever an upgrade of this game ends, and every 2 s while a big game's folder is still
  // being read (`scanning`).
  const ended = progress && progress.state !== 'running' ? progress : null
  const [recheck, setRecheck] = useState(0)
  useEffect(() => {
    if (!status?.scanning) return undefined
    const timer = setTimeout(() => setRecheck((n) => n + 1), 2000)
    return () => clearTimeout(timer)
  }, [status])
  useEffect(() => {
    let live = true
    api
      .upgradeStatus(game.id)
      .then((s) => {
        if (live) setStatus(s)
      })
      .catch((err) => {
        log.error('upgradeStatus failed', err)
        if (live) setFailed((err as Error).message || t('gameDetail.upgrades.readFailed'))
      })
    return () => {
      live = false
    }
  }, [game.id, ended, recheck, t])

  const title = displayTitle(game)
  const running = progress?.state === 'running' ? progress : null
  const busy = !!status?.busy || !!running

  const run = (action: UpgradeAction): void => {
    api
      .runUpgrade(game.id, action)
      .then(setStatus)
      .catch((err) => toast((err as Error).message || t('gameDetail.upgrades.failed'), 'error'))
  }

  // Turning an upgrade on: the ban-risk warning first (a risky game), then compression's load-time warning.
  const start = (action: UpgradeAction): void => {
    if (!status) return
    const thenCompressWarning = (): void => {
      if (action.kind !== 'compress') return run(action)
      openModal({
        type: 'confirm',
        title: t('gameDetail.upgrades.compressConfirm.title'),
        message: t('gameDetail.upgrades.compressConfirm.message', { title }),
        confirmLabel: t('gameDetail.upgrades.compressConfirm.confirm'),
        onConfirm: () => run(action)
      })
    }
    const warning = ENABLING_ACTIONS.has(action.kind) ? riskWarning(t, status, title) : null
    if (!warning && action.kind !== 'compress') return run(action)
    // A warning comes first: the menu closes so the dialog is on top (the upgrade's progress comes as toasts).
    onClose()
    if (!warning) return thenCompressWarning()
    openModal({
      type: 'confirm',
      title: t('gameDetail.upgrades.risk.title'),
      message: warning,
      confirmLabel: t('gameDetail.upgrades.risk.confirm'),
      danger: true,
      onConfirm: () => thenCompressWarning()
    })
  }

  const onBackdropClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }

  const hint = (text: string | null | undefined): ReactElement | undefined =>
    text ? <span className="playmenu__hint">{text}</span> : undefined
  const runningHint = (upgrade: UpgradeStatus['busy']): ReactElement | undefined =>
    running && running.upgrade === upgrade
      ? hint(
          running.progress !== null
            ? `${Math.round(running.progress * 100)}% · ${running.message}`
            : running.message
        )
      : undefined

  let body: ReactElement
  if (failed) body = <p className="playmenu__status playmenu__status--error">{failed}</p>
  else if (!status)
    body = <Spinner label={t('gameDetail.upgrades.checkingGame')} className="playmenu__status" />
  else if (blockedOnly(status, running)) body = <p className="playmenu__status">{status.blocked}</p>
  else {
    // The hint of the rows waiting for a big game's folder to be read.
    const checking = t('gameDetail.upgrades.checkingFiles')
    const { dlls, dlss5, shaders, optiscaler, compress } = status
    const nvidia = status.gpu?.vendor === 'nvidia'
    const sizes =
      compress.size !== null && compress.onDisk !== null && compress.state !== 'none'
        ? `${formatBytes(compress.size)} → ${formatBytes(compress.onDisk)}`
        : compress.estimatedSaving !== null && compress.size !== null
          ? t('gameDetail.upgrades.savesAbout', {
              size: formatBytes(compress.size * compress.estimatedSaving)
            })
          : compress.size !== null
            ? formatBytes(compress.size)
            : null
    const stoppable = stoppableUpgrade(status, running)
    body = (
      <>
        {/* The game was started while an upgrade runs: the reason shows above the rows (disabled), Stop stays. */}
        {status.blocked ? <p className="playmenu__status">{status.blocked}</p> : null}
        <Menu aria-label={t('gameDetail.upgrades.label')}>
          <MenuItem
            focusKey={`${MENU_FOCUS_KEY}:dlls`}
            icon={<FileCog />}
            label={t('gameDetail.upgrades.dlls')}
            trailing={
              runningHint('dlls') ?? hint(status.scanning ? checking : dllHint(status.dlls))
            }
            disabled={busy || status.scanning || !dlls.updatable}
            onPress={() => start({ kind: 'dlls-update' })}
          />
          {dlls.restorable ? (
            <MenuItem
              focusKey={`${MENU_FOCUS_KEY}:dlls-restore`}
              icon={<Undo2 />}
              label={t('gameDetail.upgrades.restore')}
              disabled={busy}
              onPress={() => run({ kind: 'dlls-restore' })}
            />
          ) : null}
          <MenuItem
            focusKey={`${MENU_FOCUS_KEY}:dlss5`}
            icon={<Sparkles />}
            label="DLSS 5"
            trailing={
              runningHint('dlss5') ??
              hint(
                dlss5.unavailable ??
                  (dlss5.appReady
                    ? t('gameDetail.upgrades.dlss5Opens')
                    : t('gameDetail.upgrades.dlss5Downloads'))
              )
            }
            disabled={busy || !!dlss5.unavailable}
            onPress={() => start({ kind: 'dlss5-open' })}
          />
          <MenuItem
            focusKey={`${MENU_FOCUS_KEY}:shaders`}
            icon={<Zap />}
            label={t('gameDetail.upgrades.shaders')}
            trailing={
              runningHint('shaders') ?? hint(shaderHint(shaders, (iso) => formatDate(iso, 'short')))
            }
            disabled={busy || !!shaders.unavailable}
            onPress={() => start({ kind: 'shaders-compile' })}
          />
          {optiscaler.installed ? (
            <MenuItem
              focusKey={`${MENU_FOCUS_KEY}:optiscaler`}
              icon={<X />}
              label={t('gameDetail.upgrades.removeOptiScaler')}
              trailing={runningHint('optiscaler') ?? hint(optiscaler.installed.version)}
              disabled={busy}
              onPress={() => run({ kind: 'optiscaler-remove' })}
            />
          ) : (
            <MenuItem
              focusKey={`${MENU_FOCUS_KEY}:optiscaler`}
              icon={<Layers />}
              label={t('gameDetail.upgrades.installOptiScaler')}
              trailing={
                runningHint('optiscaler') ??
                hint(
                  status.scanning
                    ? checking
                    : !optiscaler.hasInputs
                      ? t('gameDetail.upgrades.optiScalerNeedsInputs')
                      : nvidia
                        ? t('gameDetail.upgrades.optiScalerNvidia')
                        : t('gameDetail.upgrades.optiScalerOther')
                )
              }
              disabled={busy || status.scanning || !optiscaler.hasInputs}
              onPress={() => start({ kind: 'optiscaler-install' })}
            />
          )}
          {compress.state === 'none' ? (
            <MenuItem
              focusKey={`${MENU_FOCUS_KEY}:compress`}
              icon={<Archive />}
              label={t('gameDetail.upgrades.compress')}
              trailing={runningHint('compress') ?? hint(compress.unavailable ?? sizes)}
              disabled={busy || !!compress.unavailable}
              onPress={() => start({ kind: 'compress', algorithm: 'xpress8k' })}
            />
          ) : (
            <>
              {compress.state === 'partial' ? (
                <MenuItem
                  focusKey={`${MENU_FOCUS_KEY}:compress`}
                  icon={<Archive />}
                  label={t('gameDetail.upgrades.compressAgain')}
                  trailing={
                    runningHint('compress') ?? hint(t('gameDetail.upgrades.compressPartial'))
                  }
                  disabled={busy || !!compress.unavailable}
                  onPress={() => start({ kind: 'compress', algorithm: 'xpress8k' })}
                />
              ) : null}
              <MenuItem
                focusKey={`${MENU_FOCUS_KEY}:uncompress`}
                icon={<Archive />}
                label={t('gameDetail.upgrades.uncompress')}
                trailing={
                  compress.state === 'partial'
                    ? undefined
                    : (runningHint('compress') ?? hint(sizes))
                }
                disabled={busy}
                onPress={() => run({ kind: 'uncompress' })}
              />
            </>
          )}
          {stoppable ? (
            <MenuItem
              focusKey={`${MENU_FOCUS_KEY}:cancel`}
              icon={<X />}
              label={t('gameDetail.upgrades.stop')}
              danger
              onPress={() => {
                api.cancelUpgrade(game.id).catch((err) => log.warn('cancelUpgrade failed', err))
              }}
            />
          ) : null}
          {status.gpu ? (
            <MenuItem
              focusKey={`${MENU_FOCUS_KEY}:gpu`}
              icon={<Cpu />}
              label={status.gpu.name}
              disabled
              className="upgrademenu__gpu"
            />
          ) : null}
        </Menu>
      </>
    )
  }

  return createPortal(
    <div className="playmenu-backdrop" onClick={onBackdropClick}>
      <LayerContext.Provider value={layerId}>
        <FocusContext.Provider value={MENU_FOCUS_KEY}>
          <div
            ref={ref}
            className="playmenu upgrademenu"
            style={{ left: position.left, bottom: position.bottom }}
            role="menu"
            aria-label={t('gameDetail.upgrades.label')}
            data-focus-key={MENU_FOCUS_KEY}
          >
            {body}
          </div>
        </FocusContext.Provider>
      </LayerContext.Provider>
    </div>,
    document.body
  )
}

/** Menu position: left-aligned with the anchor, bottom edge MENU_GAP_U above it. */
function place(anchor: HTMLElement): { left: number; bottom: number } {
  const rect = anchor.getBoundingClientRect()
  const unit = window.innerHeight / 1080
  return {
    left: Math.round(rect.left),
    bottom: Math.round(window.innerHeight - rect.top + MENU_GAP_U * unit)
  }
}
