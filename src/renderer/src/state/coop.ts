import type { CoopProgress, CoopRiskTool, CoopSessionEvent, CoopStatus, Game } from '@shared/types'
import { create } from 'zustand'
import { api } from '../api/client'
import { t } from '../i18n'
import { coopRiskNames } from '../lib/coop'
import { displayTitle } from '../lib/library'
import { createLog } from '../lib/log'
import { useUiStore } from './ui'

const log = createLog('coop')

/**
 * Co-Op (Nucleus Co-op split-screen) in the renderer: the handler and tool downloads' progress (bottom bar and
 * Settings > Library), the status Settings shows, and starting a game's Co-Op session from its page (with the
 * one-time warning for handlers that use DRM-removal or anti-cheat tools).
 */
interface CoopState {
  progress: CoopProgress
  status: CoopStatus | null
  /** The last session event per game (the Co-Op button says "Starting…" meanwhile). */
  sessions: Record<string, CoopSessionEvent>
}

export const useCoopStore = create<CoopState>()(() => ({
  progress: { stage: 'download', done: 0, total: 0 },
  status: null,
  sessions: {}
}))

api.on('coop:progress', (progress) => {
  useCoopStore.setState({ progress })
  // A handler download ended (also one PlayOut started by itself): Settings › Library shows the new count.
  if (progress.stage !== 'tools' && progress.total === 0) void refreshCoopStatus()
})

api.on('coop:session', (event) => {
  useCoopStore.setState((s) => ({ sessions: { ...s.sessions, [event.gameId]: event } }))
  const toast = useUiStore.getState().toast
  if (event.state === 'error' && event.message) toast(event.message, 'error', 8000)
  else if (event.state === 'starting' && event.message) toast(event.message)
})

export async function refreshCoopStatus(): Promise<CoopStatus | null> {
  try {
    const status = await api.getCoopStatus()
    useCoopStore.setState({ status })
    return status
  } catch (err) {
    log.warn('getCoopStatus failed', err)
    return null
  }
}

/** Whether a Co-Op session for the game is being prepared or started (not yet running or over). */
export function useCoopBusy(gameId: string): boolean {
  return useCoopStore((s) => {
    const state = s.sessions[gameId]?.state
    return state === 'preparing' || state === 'starting'
  })
}

function riskMessage(game: Game, risks: readonly CoopRiskTool[]): string {
  return t('state.coop.risks', { title: displayTitle(game), tools: coopRiskNames(risks) })
}

/** An IPC error's own message, without Electron's "Error invoking remote method '…': Error: " prefix. */
export function ipcErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
}

async function run(game: Game): Promise<void> {
  // The 'error' session event shows why a start failed; only a failure without one is shown here.
  useCoopStore.setState((s) => {
    const sessions = { ...s.sessions }
    delete sessions[game.id]
    return { sessions }
  })
  try {
    await api.playCoop(game.id)
  } catch (err) {
    log.warn('playCoop failed', err)
    if (useCoopStore.getState().sessions[game.id]?.state !== 'error')
      useUiStore
        .getState()
        .toast(t('state.coop.startFailed', { error: ipcErrorMessage(err) }), 'error', 8000)
  }
}

/**
 * Start the game's Co-Op session: automatic setup, unless Co-Op setup chose otherwise. A handler that uses DRM-removal
 * or anti-cheat tools asks once per game first.
 */
export function startCoop(game: Game): void {
  const risks = game.metadata.coop?.risks ?? []
  if (risks.length && !game.user.coop?.risksAccepted) {
    useUiStore.getState().openModal({
      type: 'confirm',
      title: t('state.coop.risksTitle'),
      message: riskMessage(game, risks),
      confirmLabel: t('state.coop.risksConfirm'),
      danger: true,
      onConfirm: () => {
        void api
          .updateGame(game.id, { user: { coop: { ...game.user.coop, risksAccepted: true } } })
          .then((updated) => run(updated ?? game))
          .catch((err) => {
            log.error('updateGame failed', err)
            useUiStore.getState().toast(t('state.coop.saveFailed'), 'error')
          })
      }
    })
    return
  }
  useUiStore.getState().toast(t('state.coop.starting', { title: displayTitle(game) }))
  void run(game)
}
