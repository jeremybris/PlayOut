import type { Game, LocalDeletePlan, RemoteGameInfo } from '@shared/types'
import { api } from '../api/client'
import { t } from '../i18n'
import { formatBytes } from '../lib/format'
import { displayTitle } from '../lib/library'
import { createLog } from '../lib/log'
import { useLibraryStore } from './library'
import { useStreamingStore } from './streaming'
import { useUiStore } from './ui'

const log = createLog('local-delete')

/**
 * "Delete from this PC" (PlayMenu and the cover menu): offered for an installed game of this PC only, never for a
 * host's game, while it runs, or while it is in the install queue. Main checks all of it again (services/local-delete.ts).
 */
export function canDeleteLocally(
  game: Pick<Game, 'id' | 'installed' | 'remote'> | undefined,
  state: { runningId?: string | null; queued?: boolean } = {}
): boolean {
  if (!game || !game.installed || game.remote || game.id.startsWith('remote:')) return false
  if (state.runningId === game.id) return false
  return !state.queued
}

/** The confirm text of a plan: exactly what happens, and what does not (other PCs, saves, the store account). */
export function localDeleteMessage(
  plan: LocalDeletePlan,
  title: string,
  hosts: readonly Pick<RemoteGameInfo, 'hostName' | 'downloadable' | 'streamable'>[] = []
): string {
  const lines: string[] = []
  // At most six paths, then "… and N more" (the sizes, " (12 GB)", are numbers and units: no words to translate).
  const list = (paths: readonly string[]): string =>
    [
      ...paths.slice(0, 6),
      ...(paths.length > 6 ? [t('state.localDelete.more', { count: paths.length - 6 })] : [])
    ].join('\n')
  if (plan.kind === 'files') {
    const size = plan.totalBytes !== undefined ? ` (${formatBytes(plan.totalBytes)})` : ''
    const what =
      plan.paths.length === 1
        ? `${plan.paths[0]}${size}`
        : `${t('state.localDelete.files', { count: plan.paths.length, size })}\n${list(plan.paths)}`
    lines.push(`${t('state.localDelete.toRecycleBin', { title })}\n${what}`)
    if (plan.kept?.length)
      lines.push(
        t('state.localDelete.kept', { count: plan.kept.length, files: plan.kept.join(', ') })
      )
    if (plan.updatesDlc?.paths.length) {
      const u = plan.updatesDlc
      const size = u.totalBytes !== undefined ? ` (${formatBytes(u.totalBytes)})` : ''
      lines.push(`${t('state.localDelete.updatesDlc', { size })}\n${list(u.paths)}`)
    }
  } else if (plan.kind === 'store' && plan.opens === 'settings') {
    lines.push(t('state.localDelete.windowsSettings', { title }))
  } else if (plan.kind === 'store') {
    lines.push(
      plan.storeName
        ? t('state.localDelete.store', { title, store: plan.storeName })
        : t('state.localDelete.storeUnnamed', { title })
    )
  } else if (plan.kind === 'uninstaller') {
    lines.push(t('state.localDelete.uninstaller', { title, path: plan.paths[0] ?? '' }))
  }
  if (plan.kind === 'store') lines.push(t('state.localDelete.onlyThisPcStore'))
  else if (plan.kind === 'files' && plan.folder) lines.push(t('state.localDelete.folder'))
  else if (plan.kind === 'files')
    // ROM files only: the Emulation folder's saves, states and memory cards are never in the plan.
    lines.push(t('state.localDelete.onlyThisPcFiles'))
  else lines.push(t('state.localDelete.onlyThisPcUninstaller'))
  const names = (list: readonly { hostName: string }[]): string =>
    list.map((h) => h.hostName).join(', ')
  // A host's copy shows as Download here only when it can be downloaded (a ROM); otherwise it can still be streamed.
  const download = hosts.filter((h) => h.downloadable)
  const stream = hosts.filter((h) => !h.downloadable && h.streamable)
  if (download.length)
    lines.push(t('state.localDelete.hostKeeps', { count: download.length, hosts: names(download) }))
  if (stream.length) lines.push(t('state.localDelete.hostStreams', { hosts: names(stream) }))
  return lines.join('\n\n')
}

/** Remove only the library record (the existing "Remove from library"), for a game whose files cannot go safely. */
function confirmRemoveOnly(game: Game, reason: string, onRemoved?: () => void): void {
  const title = displayTitle(game)
  const ui = useUiStore.getState()
  ui.openModal({
    type: 'confirm',
    title: t('state.localDelete.removeOnly.title'),
    message: t('state.localDelete.removeOnly.message', { title, reason }),
    confirmLabel: t('state.localDelete.removeOnly.confirm'),
    danger: true,
    onConfirm: () => {
      api
        .removeGame(game.id)
        .then(() => {
          useLibraryStore.getState().removeGame(game.id)
          useUiStore.getState().toast(t('state.localDelete.removeOnly.done', { title }))
          onRemoved?.()
        })
        .catch((err) => {
          log.error('removeGame failed', err)
          useUiStore.getState().toast(t('state.localDelete.removeOnly.failed'), 'error')
        })
    }
  })
}

/**
 * Ask main what deleting the game would do, show it in a confirm dialog and run it on confirm. `onRemoved` runs once
 * the record left the library (ROM files, a manual game's folder or uninstaller): the detail panel closes there.
 */
export async function startLocalDelete(game: Game, onRemoved?: () => void): Promise<void> {
  const title = displayTitle(game)
  const ui = useUiStore.getState()
  let plan: LocalDeletePlan
  try {
    plan = await api.getLocalDeletePlan(game.id)
  } catch (err) {
    log.error('getLocalDeletePlan failed', err)
    ui.toast(t('state.localDelete.checkFailed', { title }), 'error')
    return
  }
  if (plan.kind === 'refused') {
    ui.toast(plan.reason ?? t('state.localDelete.refused', { title }), 'error')
    return
  }
  if (plan.kind === 'remove-only') {
    confirmRemoveOnly(game, plan.reason ?? t('state.localDelete.notSafe'), onRemoved)
    return
  }
  const hosts = useStreamingStore.getState().remote?.alsoOnHost[game.id] ?? []
  ui.openModal({
    type: 'confirm',
    title: t('state.localDelete.title'),
    message: localDeleteMessage(plan, title, hosts),
    confirmLabel:
      plan.kind === 'store'
        ? plan.opens === 'settings'
          ? t('state.localDelete.confirm.windowsSettings')
          : plan.storeName
            ? t('state.localDelete.confirm.store', { store: plan.storeName })
            : t('state.localDelete.confirm.storeUnnamed')
        : plan.kind === 'uninstaller'
          ? t('state.localDelete.confirm.uninstaller')
          : t('state.localDelete.confirm.delete'),
    danger: true,
    // The game's updates and DLC (PS3 / Switch / Xbox 360): listed above, deleted with it unless this is turned off.
    ...(plan.updatesDlc?.paths.length
      ? {
          option: {
            label: t('state.localDelete.updatesOption.label'),
            description: t('state.localDelete.updatesOption.description'),
            checked: true
          }
        }
      : {}),
    onConfirm: (withUpdatesDlc) => {
      api
        .deleteGameLocally(game.id, {
          updatesDlc: !!plan.updatesDlc?.paths.length && withUpdatesDlc
        })
        .then((result) => {
          const toast = useUiStore.getState().toast
          if (!result.ok) {
            toast(result.message, 'error')
            return
          }
          toast(result.message, 'success')
          if (result.removed) {
            useLibraryStore.getState().removeGame(game.id)
            onRemoved?.()
          }
        })
        .catch((err) => {
          log.error('deleteGameLocally failed', err)
          useUiStore.getState().toast(t('state.localDelete.failed', { title }), 'error')
        })
    }
  })
}
