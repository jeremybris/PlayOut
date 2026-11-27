import type { Game, SteamDlcInfo, SteamDlcItem } from '@shared/types'
import { api } from '../api/client'
import { t } from '../i18n'
import { formatBytes } from '../lib/format'
import { displayTitle } from '../lib/library'
import { createLog } from '../lib/log'
import { storeNameOf } from '../lib/platforms'
import { queuedToastText } from './installQueue'
import { useInstallsStore } from './installs'
import { useUiStore } from './ui'

const log = createLog('steam-dlc')

/**
 * Install a store game through its client, with the toasts the game page has always shown: refused (the reason),
 * queued behind another download, or started. Resolves true when the install started or was queued.
 */
export async function startStoreInstall(game: Game): Promise<boolean> {
  const storeName = storeNameOf(game.source)
  if (game.installed || game.remote || !storeName) return false
  const title = displayTitle(game)
  const toast = useUiStore.getState().toast
  useInstallsStore.getState().remove(game.id)
  try {
    const result = await api.installGame(game.id)
    if (!result.ok) {
      log.warn(`install of ${game.id} refused`, result.error)
      toast(result.error ?? t('state.steamDlc.installFailed', { title }), 'error')
      return false
    }
    if (result.queued) toast(queuedToastText(title, game.id))
    else toast(t('state.steamDlc.installing', { title, store: storeName }))
    return true
  } catch (err) {
    log.error('installGame failed', err)
    toast(t('state.steamDlc.installFailed', { title }), 'error')
    return false
  }
}

/**
 * Install a Steam game and turn off `disabled` once the install finishes (Steam installs every owned DLC; main applies
 * the choice afterwards and reports it through 'steam-dlc:applied'). The choice is always sent once the install
 * started, even with every DLC on: that replaces a choice saved for an earlier install of the game that was stopped.
 */
export async function installSteamGame(game: Game, disabled: number[]): Promise<void> {
  const started = await startStoreInstall(game)
  if (!started) return
  try {
    const result = await api.setSteamDlc(game.id, disabled)
    if (!result.ok)
      useUiStore
        .getState()
        .toast(
          result.error ?? t('state.steamDlc.saveFailed', { title: displayTitle(game) }),
          'error'
        )
  } catch (err) {
    log.error('setSteamDlc failed', err)
    useUiStore
      .getState()
      .toast(t('state.steamDlc.saveFailed', { title: displayTitle(game) }), 'error')
  }
}

/** A Steam game's DLC list can be changed here: a local, installed Steam copy (Manage DLC). */
export function canManageSteamDlc(game: Game | undefined): boolean {
  return !!game && game.source === 'steam' && game.installed && !game.remote
}

/** The install picker replaces a plain install: a local Steam game that is not installed. */
export function picksSteamDlc(game: Game | undefined): boolean {
  return !!game && game.source === 'steam' && !game.installed && !game.remote
}

/** DLC the picker can turn on or off (Steam-only ones are changed on Steam's own page). */
export function choosableDlc(info: SteamDlcInfo | null): SteamDlcItem[] {
  return info ? info.dlc.filter((d) => !d.steamOnly) : []
}

/**
 * The switches the dialog starts with (appId -> on): at install time the planned choice (else every DLC on), in
 * Manage DLC Steam's current choice.
 */
export function initialChoice(
  info: SteamDlcInfo,
  mode: 'install' | 'manage'
): Record<number, boolean> {
  const planned = mode === 'install' && info.plannedDisabled ? new Set(info.plannedDisabled) : null
  const out: Record<number, boolean> = {}
  for (const d of info.dlc)
    out[d.appId] = mode === 'install' && !d.steamOnly ? !planned?.has(d.appId) : d.enabled
  return out
}

/** The DLC to turn off for a choice: every one switched off (Steam-only ones keep what Steam has). */
export function disabledFrom(info: SteamDlcInfo, choice: Record<number, boolean>): number[] {
  return info.dlc
    .filter((d) => (d.steamOnly ? !d.enabled : choice[d.appId] === false))
    .map((d) => d.appId)
}

/** Manage DLC: the choice differs from what Steam has. */
export function choiceChanged(info: SteamDlcInfo, choice: Record<number, boolean>): boolean {
  return choosableDlc(info).some((d) => (choice[d.appId] ?? d.enabled) !== d.enabled)
}

/** The line under a DLC's name. */
export function dlcDescription(item: SteamDlcItem, mode: 'install' | 'manage'): string {
  const parts: string[] = []
  if (item.sizeBytes === null) parts.push(t('state.steamDlc.noDownload'))
  else parts.push(formatBytes(item.sizeBytes))
  if (item.steamOnly) parts.push(t('state.steamDlc.changeInSteam'))
  if (mode === 'manage') {
    if (item.pending) parts.push(t('state.steamDlc.pending'))
    else if (item.installed) parts.push(t('state.steamDlc.installed'))
  }
  return parts.join(' · ')
}

// Main applied the DLC turned off at install time once the install finished (or could not).
api.on('steam-dlc:applied', ({ title, ok, error }) => {
  const toast = useUiStore.getState().toast
  if (ok) toast(t('state.steamDlc.applied', { title }), 'success')
  else toast(error ?? t('state.steamDlc.applyFailed', { title }), 'error', 8000)
})
