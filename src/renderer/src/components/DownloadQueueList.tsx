import type { InstallQueueEntry } from '@shared/types'
import { ArrowDown, ArrowUp, CircleStop, Download, Hourglass, Pause, Play, X } from 'lucide-react'
import { useEffect, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { useFocusableControl } from '../hooks/useFocusableControl'
import { useT, type Translate } from '../i18n'
import {
  FocusContext,
  doesFocusableExist,
  getCurrentFocusKey,
  setFocus,
  useFocusable
} from '../input/focus'
import { cx } from '../lib/cx'
import {
  downloadQueueAllKey,
  downloadQueueEmptyKey,
  downloadQueueRowKey,
  downloadQueueSafeFocusKey
} from '../lib/focusKeys'
import { hostOfflineWait, romDownloadProgressView, type ProgressView } from '../lib/streaming'
import { formatBytes, installPercent, installStalled, useInstallProgress } from '../state/installs'
import {
  queueAllPaused,
  queueMoveFocusPart,
  queuePausedText,
  QUEUE_STARTING_VIEW,
  queuePlaceText,
  queueStarting,
  useInstallQueue,
  useInstallQueueStore
} from '../state/installQueue'
import { useRomDownload } from '../state/streaming'
import { useUiStore } from '../state/ui'
import { Button } from './Button'
import { IconButton } from './IconButton'

export interface DownloadQueueListProps {
  /** Container focus key; every row's buttons are keyed under it. */
  focusKey: string
  /** Where focus goes when the list empties under it (the list unmounts its last button). */
  fallbackFocusKey?: string
}

/**
 * The install queue (state/installQueue.ts) as a list: the game downloading now with its live bar (a store install's
 * tracked progress, or a ROM download from another PC), then the waiting games in order. Waiting rows move up / down
 * or leave the queue; the active row stops once confirmed (Stop tracking for a store, Cancel download for a host
 * ROM). Every row pauses / resumes (a paused row says "Paused"; the store install PlayOut cannot pause says to pause it
 * in the store too), and "Pause all" / "Resume all" sits above the rows. Used by the quick panel and the overlay's
 * Downloads tab; "No downloads" when the queue is empty.
 */
export function DownloadQueueList({
  focusKey,
  fallbackFocusKey
}: DownloadQueueListProps): ReactElement {
  const t = useT()
  const entries = useInstallQueue()
  const emptyKey = downloadQueueEmptyKey(focusKey)
  const empty = entries.length === 0
  const { ref, focusKey: listKey } = useFocusable<object, HTMLDivElement>({
    focusKey,
    trackChildren: true,
    saveLastFocusedChild: true,
    // Entering the list lands on the first row's title, never on the running download's stop button; on an empty
    // queue, on the "No downloads" line (never on the list itself, which has nothing to move to).
    preferredChildFocusKey: downloadQueueSafeFocusKey(focusKey, entries) ?? emptyKey
  })
  // The last row went while focused (it finished, or was removed here or in the other window): focus that was left
  // on the list or on a row that no longer exists moves to the "No downloads" line.
  useEffect(() => {
    if (!empty) return
    const frame = requestAnimationFrame(() => {
      const current = getCurrentFocusKey()
      const stranded =
        current === listKey ||
        (!!current && current.startsWith(`${listKey}:`) && !doesFocusableExist(current))
      if (stranded && doesFocusableExist(emptyKey)) void setFocus(emptyKey)
    })
    return () => cancelAnimationFrame(frame)
  }, [empty, listKey, emptyKey])
  const waiting = entries.filter((e) => e.state === 'waiting')
  return (
    <FocusContext.Provider value={listKey}>
      <div ref={ref} className="dlq">
        {empty ? null : (
          <PauseAllButton
            focusKey={downloadQueueAllKey(listKey)}
            allPaused={queueAllPaused(entries)}
          />
        )}
        <div className="dlq__rows" role="list" aria-label={t('components.downloadQueue.label')}>
          {empty ? <EmptyLine focusKey={emptyKey} /> : null}
          {entries.map((entry) => {
            const place = waiting.indexOf(entry) + 1
            return (
              <QueueRow
                key={entry.gameId}
                entry={entry}
                listKey={listKey}
                fallbackFocusKey={fallbackFocusKey}
                place={place}
                last={place === waiting.length}
              />
            )
          })}
        </div>
      </div>
    </FocusContext.Provider>
  )
}

/** "No downloads": a focus stop (no action) so focus in an empty list rests on something visible. */
function EmptyLine({ focusKey }: { focusKey: string }): ReactElement {
  const t = useT()
  const { ref, props } = useFocusableControl<HTMLDivElement>({ focusKey })
  return (
    <div ref={ref} className="dlq__empty" {...props}>
      {t('components.downloadQueue.empty')}
    </div>
  )
}

/** "Pause all" while any game downloads or waits unpaused, else "Resume all" (same focus key: focus stays on it). */
function PauseAllButton({
  focusKey,
  allPaused
}: {
  focusKey: string
  allPaused: boolean
}): ReactElement {
  const t = useT()
  const { pause, resume } = useInstallQueueStore.getState()
  return (
    <div className="dlq__toolbar">
      <Button
        focusKey={focusKey}
        variant="ghost"
        icon={allPaused ? <Play /> : <Pause />}
        onPress={() => void (allPaused ? resume(null) : pause(null))}
      >
        {allPaused
          ? t('components.downloadQueue.resumeAll')
          : t('components.downloadQueue.pauseAll')}
      </Button>
    </div>
  )
}

/** A row's title and detail: a focus stop of its own (no action) so focus can rest on a row without arming a button. */
function RowInfo({ focusKey, children }: { focusKey: string; children: ReactNode }): ReactElement {
  const { ref, props } = useFocusableControl<HTMLDivElement>({ focusKey })
  return (
    <div ref={ref} className="dlq__main" {...props}>
      {children}
    </div>
  )
}

/**
 * After a change the pressed button can be gone (the row left or started): focus the first of `keys` that exists,
 * else the list (its remembered or first button, or "No downloads"), else the fallback. A button that still exists
 * keeps focus (a disabled one too: moveAndRefocus handles an arrow that turned disabled).
 */
function refocus(keys: string[], listKey: string, fallbackFocusKey: string | undefined): void {
  requestAnimationFrame(() => {
    const current = getCurrentFocusKey()
    if (current && doesFocusableExist(current)) return
    const target = [...keys, listKey, fallbackFocusKey].find(
      (key): key is string => !!key && doesFocusableExist(key)
    )
    if (target) void setFocus(target)
  })
}

type StopKind = 'remove' | 'cancelDownload' | 'cancelInstall' | 'stopTracking'

interface StopTexts {
  /** The button's own words, and the confirm button's. */
  label: string
  /** What assistive tech reads for the button: the words and the game. */
  aria: string
  /** The confirmation asked before stopping the running download (not asked when leaving the queue). */
  confirmTitle: string
  confirmMessage: string
}

/**
 * A row's stop button: Remove from queue for a waiting game, else what stopping the running one means (Cancel download
 * for a host ROM, Cancel install for a store install not seen yet, Stop tracking for one the store is downloading).
 * Whole sentences per kind, so a translation can word each one its own way.
 */
function stopTexts(kind: StopKind, entry: InstallQueueEntry, t: Translate): StopTexts {
  const vars = { title: entry.title, from: entry.from }
  switch (kind) {
    case 'remove':
      return {
        label: t('components.downloadQueue.stop.remove.label'),
        aria: t('components.downloadQueue.stop.remove.aria', vars),
        confirmTitle: '',
        confirmMessage: ''
      }
    case 'cancelDownload':
      return {
        label: t('components.downloadQueue.stop.cancelDownload.label'),
        aria: t('components.downloadQueue.stop.cancelDownload.aria', vars),
        confirmTitle: t('components.downloadQueue.stop.cancelDownload.confirmTitle'),
        confirmMessage: t('components.downloadQueue.stop.cancelDownload.confirmMessage', vars)
      }
    case 'cancelInstall':
      return {
        label: t('components.downloadQueue.stop.cancelInstall.label'),
        aria: t('components.downloadQueue.stop.cancelInstall.aria', vars),
        confirmTitle: t('components.downloadQueue.stop.cancelInstall.confirmTitle'),
        confirmMessage: t('components.downloadQueue.stop.cancelInstall.confirmMessage', vars)
      }
    case 'stopTracking':
      return {
        label: t('components.downloadQueue.stop.stopTracking.label'),
        aria: t('components.downloadQueue.stop.stopTracking.aria', vars),
        confirmTitle: t('components.downloadQueue.stop.stopTracking.confirmTitle'),
        confirmMessage: t('components.downloadQueue.stop.stopTracking.confirmMessage', vars)
      }
  }
}

function QueueRow({
  entry,
  listKey,
  fallbackFocusKey,
  place,
  last
}: {
  entry: InstallQueueEntry
  listKey: string
  fallbackFocusKey: string | undefined
  /** 1-based place among the waiting games; 0 for the active one. */
  place: number
  last: boolean
}): ReactElement {
  const t = useT()
  const { remove, move, pause, resume } = useInstallQueueStore.getState()
  const active = entry.state === 'active'
  const paused = !!entry.paused
  const keys = {
    info: downloadQueueRowKey(listKey, entry.gameId, 'info'),
    pause: downloadQueueRowKey(listKey, entry.gameId, 'pause'),
    up: downloadQueueRowKey(listKey, entry.gameId, 'up'),
    down: downloadQueueRowKey(listKey, entry.gameId, 'down'),
    remove: downloadQueueRowKey(listKey, entry.gameId, 'remove')
  }
  /**
   * Move this row, then keep focus on it: Norigin keeps a disabled button registered (and focused), so when the
   * pressed arrow turned disabled (the row reached the top or the bottom) focus goes to the other arrow, else Remove.
   */
  const moveAndRefocus = (pressed: 'up' | 'down'): void =>
    void move(entry.gameId, pressed === 'up' ? -1 : 1).then(() =>
      requestAnimationFrame(() => {
        const part = queueMoveFocusPart(
          useInstallQueueStore.getState().entries,
          entry.gameId,
          pressed
        )
        if (!part) return refocus([], listKey, fallbackFocusKey)
        if (part !== pressed && getCurrentFocusKey() === keys[pressed]) void setFocus(keys[part])
      })
    )
  const from =
    entry.kind === 'host-rom'
      ? t('components.downloadQueue.fromHost', { host: entry.from })
      : entry.from
  // A store install handed off but not yet seen in the store ("Starting…"): nothing is known to download yet.
  const install = useInstallProgress(active && entry.kind === 'store' ? entry.gameId : null)
  const starting = active && entry.kind === 'store' && queueStarting(0, install)
  // Held back rather than next in line (a ROM whose PC is offline: "Waiting for <host> to come back online"), from
  // main's queue; until that arrives, from the download's own 'failed' event saying so.
  const download = useRomDownload(!active && entry.kind === 'host-rom' ? entry.gameId : null)
  const heldBack = entry.waitingFor ?? hostOfflineWait(download)
  // A paused ROM download from another PC keeps what it reached (it continues from there when resumed).
  const pausedAt = download?.state === 'paused' && download.bytesTotal > 0 ? download.percent : null
  const stop = stopTexts(
    !active
      ? 'remove'
      : entry.kind === 'host-rom'
        ? 'cancelDownload'
        : starting
          ? 'cancelInstall'
          : 'stopTracking',
    entry,
    t
  )
  return (
    <div
      className={cx('dlq__row', active && 'dlq__row--active', paused && 'dlq__row--paused')}
      role="listitem"
    >
      <span className="dlq__icon" aria-hidden="true">
        {paused ? <Pause /> : active ? <Download /> : <Hourglass />}
      </span>
      <RowInfo focusKey={keys.info}>
        <span className="dlq__title u-truncate">{entry.title}</span>
        {active ? (
          <ActiveProgress entry={entry} from={from} />
        ) : (
          <span className="dlq__detail u-truncate">
            {t('components.downloadQueue.waitingDetail', {
              from,
              status: paused
                ? queuePausedText(entry, pausedAt)
                : (heldBack ?? t('components.downloadQueue.waiting')),
              place: queuePlaceText(place)
            })}
          </span>
        )}
      </RowInfo>
      <div className="dlq__actions">
        <IconButton
          focusKey={keys.pause}
          icon={paused ? <Play /> : <Pause />}
          aria-label={
            paused
              ? t('components.downloadQueue.resume', { title: entry.title })
              : t('components.downloadQueue.pause', { title: entry.title })
          }
          size="sm"
          variant="ghost"
          // The row stays (a paused download from another PC moves below the next one, which starts): focus stays on
          // this button, now the other way round.
          onPress={() =>
            void (paused ? resume(entry.gameId) : pause(entry.gameId)).then(() =>
              refocus([keys.info], listKey, fallbackFocusKey)
            )
          }
        />
        {active ? null : (
          <>
            <IconButton
              focusKey={keys.up}
              icon={<ArrowUp />}
              aria-label={t('components.downloadQueue.moveUp', { title: entry.title })}
              size="sm"
              variant="ghost"
              disabled={place <= 1}
              onPress={() => moveAndRefocus('up')}
            />
            <IconButton
              focusKey={keys.down}
              icon={<ArrowDown />}
              aria-label={t('components.downloadQueue.moveDown', { title: entry.title })}
              size="sm"
              variant="ghost"
              disabled={last}
              onPress={() => moveAndRefocus('down')}
            />
          </>
        )}
        <IconButton
          focusKey={keys.remove}
          icon={active ? <CircleStop /> : <X />}
          aria-label={stop.aria}
          size="sm"
          variant="ghost"
          onPress={() => {
            const run = (): void =>
              void remove(entry.gameId).then(() => refocus([], listKey, fallbackFocusKey))
            if (!active) return run()
            // Stopping the running download is asked first: focus entering the list lands on this button.
            useUiStore.getState().openModal({
              type: 'confirm',
              title: stop.confirmTitle,
              message: stop.confirmMessage,
              confirmLabel: stop.label,
              danger: entry.kind === 'host-rom',
              onConfirm: run
            })
          }}
        />
      </div>
    </div>
  )
}

/** The active row's second line and bar, from the store install's progress or the host ROM's download. */
function ActiveProgress({ entry, from }: { entry: InstallQueueEntry; from: string }): ReactElement {
  const t = useT()
  const install = useInstallProgress(entry.kind === 'store' ? entry.gameId : null)
  const download = useRomDownload(entry.gameId)
  // A host ROM whose turn came holds the ended attempt before it (the "Waiting for <host>…" of a PC that went
  // offline) until its first progress: it is starting again, not failed.
  const view: ProgressView | undefined =
    entry.kind === 'host-rom'
      ? download && !queueStarting(0, download)
        ? romDownloadProgressView(download)
        : QUEUE_STARTING_VIEW
      : install
  // An ended attempt still in the queue shows its message on an indeterminate bar, not the last percent.
  const percent = view?.state === 'failed' ? null : installPercent(view)
  const bytes =
    view?.bytesDone !== undefined && view.bytesTotal !== undefined
      ? t('components.downloadQueue.bytes', {
          done: formatBytes(view.bytesDone),
          total: formatBytes(view.bytesTotal)
        })
      : null
  // A store install the store stopped moving ("No progress from <Store> for 30 minutes…") keeps its percent and says
  // why it does not move in place of the bytes.
  const stalled = installStalled(view)
  // Paused while the store downloads (PlayOut cannot pause it): no live percent, and where to pause it.
  const status = entry.paused
    ? queuePausedText(entry, percent)
    : percent !== null
      ? [
          t('components.downloadQueue.percent', { percent: Math.round(percent) }),
          stalled ? view?.message : bytes
        ]
          .filter(Boolean)
          .join(' · ')
      : (view?.message ?? t('components.downloadQueue.starting'))
  return (
    <>
      <span className="dlq__detail u-truncate">
        {t('components.downloadQueue.activeDetail', { from, status })}
      </span>
      <span
        className={cx(
          'dlq__bar',
          percent === null && !entry.paused && 'dlq__bar--indeterminate',
          entry.paused && 'dlq__bar--paused'
        )}
        style={percent === null ? undefined : ({ '--p': percent } as CSSProperties)}
        role="progressbar"
        aria-label={t('components.downloadQueue.progressLabel', { title: entry.title, status })}
        aria-valuenow={percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      />
    </>
  )
}
