import type { ConvertStatus } from '@shared/convert'
import { create } from 'zustand'
import { api } from '../api/client'
import { t } from '../i18n'
import { useUiStore } from './ui'

/** Settings › Convert's run as main reports it ('convert:progress'): the converter's download and each file's state. */
export const useConvertStore = create<{ status: ConvertStatus | null }>()(() => ({ status: null }))

/** Conversions started from a game's Play menu, by path: their outcome is toasted when the run ends. */
const watched = new Map<string, { title: string; to: string }>()

/** Toast the outcome of the conversion of `path` (started from a game's Play menu) when its run ends. */
export function watchConversion(path: string, title: string, to: string): void {
  watched.set(path.toLowerCase(), { title, to })
}

/** The toast for one watched item that ended: its text and kind, or null while it has not ended. */
export function conversionOutcome(
  item: ConvertStatus['items'][number],
  title: string,
  to: string
): { text: string; kind: 'success' | 'error' | 'info' } | null {
  switch (item.state) {
    case 'done':
      return {
        text: item.detail
          ? t('state.convert.doneDetail', { title, format: to, detail: item.detail })
          : t('state.convert.done', { title, format: to }),
        kind: 'success'
      }
    case 'failed':
      return {
        text: item.detail
          ? t('state.convert.failedDetail', { title, detail: item.detail })
          : t('state.convert.failed', { title }),
        kind: 'error'
      }
    case 'skipped':
      return {
        text: item.detail
          ? t('state.convert.skippedDetail', { title, detail: item.detail })
          : t('state.convert.skipped', { title }),
        kind: 'info'
      }
    case 'stopped':
      return { text: t('state.convert.stopped', { title }), kind: 'info' }
    default:
      return null
  }
}

api.on('convert:progress', (status) => {
  useConvertStore.setState({ status })
  if (status.running || !watched.size) return
  for (const item of status.items) {
    const key = item.path.toLowerCase()
    const w = watched.get(key)
    if (!w) continue
    watched.delete(key)
    const outcome = conversionOutcome(item, w.title, w.to)
    if (outcome)
      useUiStore
        .getState()
        .toast(outcome.text, outcome.kind, outcome.kind === 'error' ? 8000 : undefined)
  }
})

export async function refreshConvertStatus(): Promise<void> {
  const status = await api.getConvertStatus()
  useConvertStore.setState({ status })
}

/**
 * The toast when Trim Games (Settings › Library) starts converting games: new ones, or (`fromLibrary`) the games
 * already in the library, looked at when it was switched on.
 */
export function trimStartedText(count: number, titles: string[], fromLibrary = false): string {
  if (count === 1 && titles[0]) return t('state.convert.trimmingOne', { title: titles[0] })
  return fromLibrary
    ? t('state.convert.trimmingLibrary', { count })
    : t('state.convert.trimmingNew', { count })
}

/** The toast when Trim Games leaves a game (or, with `count`, several for one reason) as it is. */
export function trimSkippedText(title: string, reason: string, count?: number): string {
  return count && count > 1
    ? t('state.convert.trimSkippedMany', { count, reason })
    : t('state.convert.trimSkipped', { title, reason })
}

// Trim Games converts ROM games in the background (main/convert/auto-trim.ts): its runs and skips are toasted.
api.on('trim:started', ({ count, titles, fromLibrary }) =>
  useUiStore.getState().toast(trimStartedText(count, titles, fromLibrary))
)
api.on('trim:skipped', ({ title, reason, count }) =>
  useUiStore.getState().toast(trimSkippedText(title, reason, count), 'error', 8000)
)
