import type {
  EmulationMoveMode,
  EmulationMovePlan,
  EmulationMoveProgress,
  EmulationMoveRequest,
  EmulationMoveResult
} from '@shared/emulation-move'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { Spinner } from '../../components/Spinner'
import { useT, type Translate } from '../../i18n'
import { formatBytes } from '../../lib/format'
import { createLog } from '../../lib/log'
import { ipcErrorMessage } from '../../state/coop'
import { useUiStore } from '../../state/ui'

const log = createLog('emulation-move')
const KEY = 'emumove'

export interface EmulationMoveDialogProps {
  request: EmulationMoveRequest
  /**
   * Opened at startup because the Emulation folder is inside PlayOut's install folder: the question is worded for it,
   * and any answer is remembered (not asked again).
   */
  offer?: boolean
  /** After the Emulation folder changed (moved or switched): its new path. */
  onDone?: (dir: string) => void
  onClose: () => void
}

type Step =
  | { kind: 'planning' }
  | { kind: 'plan'; plan: EmulationMovePlan }
  | { kind: 'moving'; plan: EmulationMovePlan }
  | { kind: 'done'; plan: EmulationMovePlan; result: EmulationMoveResult }
  | { kind: 'error'; message: string; plan?: EmulationMovePlan }

/** The plan's lines: from, to, what moves and how. */
function planLines(t: Translate, plan: EmulationMovePlan): string[] {
  const lines = [
    t('emulationMove.from', { path: plan.from }),
    t('emulationMove.to', { path: plan.to })
  ]
  if (!plan.hasContent) {
    lines.push(t('emulationMove.nothingToMove'))
    return lines
  }
  lines.push(t('emulationMove.size', { size: formatBytes(plan.bytes), count: plan.files }))
  if (plan.targetHasContent)
    lines.push(
      plan.targetIsEmulation
        ? t('emulationMove.targetIsEmulation')
        : t('emulationMove.targetNotEmpty')
    )
  else lines.push(plan.sameDrive ? t('emulationMove.sameDrive') : t('emulationMove.otherDrive'))
  if (plan.freeBytes !== null && plan.neededBytes > 0)
    lines.push(t('emulationMove.free', { free: formatBytes(plan.freeBytes) }))
  return lines
}

function phaseText(t: Translate, p: EmulationMoveProgress | null): string {
  switch (p?.phase) {
    case 'copying':
      return t('emulationMove.phase.copying')
    case 'verifying':
      return t('emulationMove.phase.verifying')
    case 'switching':
      return t('emulationMove.phase.switching')
    case 'cleaning':
      return t('emulationMove.phase.cleaning')
    default:
      return t('emulationMove.phase.moving')
  }
}

/**
 * Settings › Library › Emulation Folder: moving the Emulation folder. Shows what would move (from, to, size, drive,
 * free space), then the move's progress (Cancel stops it: nothing moved), then the result. A new place that already
 * holds files asks: move into it (newer files there are kept) or use it as it is.
 */
export function EmulationMoveDialog({
  request,
  offer,
  onDone,
  onClose
}: EmulationMoveDialogProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const [step, setStep] = useState<Step>({ kind: 'planning' })
  const [progress, setProgress] = useState<EmulationMoveProgress | null>(null)
  const answered = useRef(false)

  const answerOffer = useCallback(() => {
    if (!offer || answered.current) return
    answered.current = true
    api.answerEmulationFolderOffer().catch((err) => log.error('answerEmulationFolderOffer', err))
  }, [offer])

  useEffect(() => {
    let live = true
    api
      .planEmulationMove(request)
      .then((plan) => {
        if (live) setStep({ kind: 'plan', plan })
      })
      .catch((err) => {
        log.error('planEmulationMove failed', err)
        if (live) setStep({ kind: 'error', message: ipcErrorMessage(err) })
      })
    return () => {
      live = false
    }
  }, [request])

  useEffect(() => api.on('emulation-move:progress', (p) => setProgress(p)), [])

  const start = useCallback(
    (plan: EmulationMovePlan, mode: EmulationMoveMode) => {
      setStep({ kind: 'moving', plan })
      setProgress(null)
      api
        .startEmulationMove(plan.to, mode)
        .then((result) => {
          answerOffer()
          setStep({ kind: 'done', plan, result })
          onDone?.(result.dir)
          toast(
            result.moved
              ? t('emulationMove.toastMoved', { path: result.dir })
              : t('emulationMove.toastSwitched', { path: result.dir }),
            'success'
          )
        })
        .catch((err) => {
          log.error('startEmulationMove failed', err)
          setStep({ kind: 'error', message: ipcErrorMessage(err), plan })
        })
    },
    [answerOffer, onDone, t, toast]
  )

  const moving = step.kind === 'moving'
  const close = (): void => {
    if (moving) return
    // Only a real "Not now" (a move that could have gone ahead) is remembered: a plan refused for now (a game running,
    // a setup, too little room) or a failed move leaves the offer for the next start.
    if (step.kind === 'plan' && !step.plan.blocked && !step.plan.same) answerOffer()
    onClose()
  }

  let body: ReactElement
  let footer: ReactElement
  if (step.kind === 'planning') {
    body = (
      <p className="dialog__message">
        <Spinner size="sm" /> {t('emulationMove.measuring')}
      </p>
    )
    footer = (
      <Button focusKey={`${KEY}:cancel`} onPress={close}>
        {t('emulationMove.cancel')}
      </Button>
    )
  } else if (step.kind === 'plan') {
    const { plan } = step
    const lines = planLines(t, plan)
    body = (
      <>
        {offer ? <p className="dialog__message">{t('emulationMove.offerLead')}</p> : null}
        {plan.same ? (
          <p className="dialog__message">{t('emulationMove.same', { path: plan.to })}</p>
        ) : (
          lines.map((line) => (
            <p key={line} className="dialog__message">
              {line}
            </p>
          ))
        )}
        {plan.blocked ? (
          <p className="dialog__message dialog__message--error">{plan.blocked}</p>
        ) : null}
      </>
    )
    const ok = !plan.blocked && !plan.same
    footer = (
      <>
        <Button focusKey={`${KEY}:cancel`} onPress={close}>
          {offer ? t('emulationMove.notNow') : t('emulationMove.cancel')}
        </Button>
        {ok && plan.hasContent && plan.targetHasContent ? (
          <>
            <Button focusKey={`${KEY}:switch`} onPress={() => start(plan, 'switch')}>
              {t('emulationMove.useAsIs')}
            </Button>
            <Button focusKey={`${KEY}:ok`} variant="primary" onPress={() => start(plan, 'merge')}>
              {t('emulationMove.moveInto')}
            </Button>
          </>
        ) : ok ? (
          <Button
            focusKey={`${KEY}:ok`}
            variant="primary"
            onPress={() => start(plan, plan.hasContent ? 'move' : 'switch')}
          >
            {plan.hasContent ? t('emulationMove.move') : t('emulationMove.use')}
          </Button>
        ) : null}
      </>
    )
  } else if (step.kind === 'moving') {
    const total = progress?.bytesTotal || step.plan.bytes
    const done = progress?.bytesDone ?? 0
    const copying = progress?.phase === 'copying'
    const percent = copying && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null
    body = (
      <>
        <p className="dialog__message">{phaseText(t, progress)}</p>
        {copying ? (
          <p className="dialog__message">
            {t('emulationMove.progress', {
              done: formatBytes(done),
              total: formatBytes(total),
              files: progress?.filesDone ?? 0,
              filesTotal: progress?.filesTotal || step.plan.files
            })}
          </p>
        ) : null}
        {progress?.current ? (
          <p className="dialog__message u-truncate">{progress.current}</p>
        ) : null}
        <span
          className={percent === null ? 'dlq__bar dlq__bar--indeterminate' : 'dlq__bar'}
          style={percent === null ? undefined : ({ '--p': percent } as CSSProperties)}
          role="progressbar"
          aria-label={t('emulationMove.progressLabel')}
          aria-valuenow={percent ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </>
    )
    footer = (
      <Button
        focusKey={`${KEY}:stop`}
        onPress={() => void api.cancelEmulationMove().catch((err) => log.error('cancel', err))}
      >
        {t('emulationMove.cancel')}
      </Button>
    )
  } else if (step.kind === 'done') {
    const { result } = step
    body = (
      <>
        <p className="dialog__message">
          {result.moved
            ? t('emulationMove.doneMoved', { path: result.dir })
            : t('emulationMove.doneSwitched', { path: result.dir })}
        </p>
        <p className="dialog__message">{t('emulationMove.doneEmulators')}</p>
        {result.leftInOld > 0 ? (
          <p className="dialog__message">
            {t('emulationMove.leftInOld', { count: result.leftInOld, path: step.plan.from })}
          </p>
        ) : null}
        {result.keptOlder > 0 ? (
          <p className="dialog__message">
            {t('emulationMove.keptOlder', { count: result.keptOlder })}
          </p>
        ) : null}
      </>
    )
    footer = (
      <Button focusKey={`${KEY}:ok`} variant="primary" onPress={close}>
        {t('emulationMove.close')}
      </Button>
    )
  } else {
    body = (
      <>
        <p className="dialog__message dialog__message--error">{step.message}</p>
        {step.plan ? (
          <p className="dialog__message">
            {t('emulationMove.unchanged', { path: step.plan.from })}
          </p>
        ) : null}
      </>
    )
    footer = (
      <Button focusKey={`${KEY}:ok`} variant="primary" onPress={close}>
        {t('emulationMove.close')}
      </Button>
    )
  }

  return (
    <Modal
      size="dialog"
      narrow
      hideClose
      className="confirm-dialog emumove"
      focusKey={KEY}
      preferredChildFocusKey={`${KEY}:ok`}
      title={offer ? t('emulationMove.offerTitle') : t('emulationMove.title')}
      onClose={close}
      closeOnBackdrop={!moving}
      footer={footer}
    >
      {body}
    </Modal>
  )
}
