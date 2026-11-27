import type {
  RecompImportItem,
  RecompImportProgress,
  RecompImportResult,
  RecompImportScan
} from '@shared/recomp'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { SelectField, type SelectOption } from '../../components/SelectField'
import { Spinner } from '../../components/Spinner'
import { TextField } from '../../components/TextField'
import { useT } from '../../i18n'
import { formatBytes } from '../../lib/format'
import { createLog } from '../../lib/log'
import { ipcErrorMessage } from '../../state/coop'
import { useUiStore } from '../../state/ui'
import './sections/recompilations.css'
import {
  CHOOSE_OTHER,
  importPhaseText,
  importRowState,
  importStartChoice,
  searchImportCatalog,
  SKIP
} from './recompImportText'

const log = createLog('recomp-import')
const KEY = 'recompimport'

type Step =
  | { kind: 'scanning' }
  | { kind: 'review'; scan: RecompImportScan }
  | { kind: 'importing'; scan: RecompImportScan; count: number }
  | { kind: 'done'; scan: RecompImportScan; result: RecompImportResult }
  | { kind: 'error'; message: string }

/**
 * Settings › Recompilations › Import: the folder picker (main opens it), then what PlayOut found in the picked folders
 * (each app folder, the launcher that made it, the recompilation it is and its version, its size and where it moves),
 * with a choice per row (one recompilation of several, any recompilation for a folder nothing matched, or Skip).
 * Nothing moves until Import is pressed; then the moves' progress (Stop: the folder being copied is put back and the
 * rest are not started) and a summary.
 */
export function RecompImportDialog({ onClose }: { onClose: () => void }): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const [step, setStep] = useState<Step>({ kind: 'scanning' })
  /** The user's choice per folder: a recompilation id, or SKIP. */
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [progress, setProgress] = useState<RecompImportProgress | null>(null)
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    let live = true
    api
      .scanRecompImport()
      .then((scan) => {
        if (!live) return
        if (!scan) {
          onClose()
          return
        }
        setPicks(Object.fromEntries(scan.items.map((i) => [i.folder, importStartChoice(i)])))
        setStep({ kind: 'review', scan })
      })
      .catch((err) => {
        log.error('scanRecompImport failed', err)
        if (live)
          setStep({
            kind: 'error',
            message: ipcErrorMessage(err) || t('settingsRecomp.import.scanFailed')
          })
      })
    return () => {
      live = false
    }
    // Once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => api.on('recomp:import-progress', (p) => setProgress(p)), [])

  const chosen = useMemo(() => {
    if (step.kind !== 'review') return []
    return step.scan.items
      .map((item) => ({
        item,
        state: importRowState(item, picks[item.folder] ?? SKIP, picks, step.scan.catalog)
      }))
      .filter((r) => r.state.ok)
      .map((r) => ({ folder: r.item.folder, recompId: picks[r.item.folder]! }))
  }, [step, picks])

  const start = useCallback(
    (scan: RecompImportScan) => {
      if (!chosen.length) return
      setStep({ kind: 'importing', scan, count: chosen.length })
      setProgress(null)
      setStopping(false)
      api
        .importRecomps(chosen)
        .then((result) => {
          setStep({ kind: 'done', scan, result })
          if (result.imported.length)
            toast(t('settingsRecomp.import.toast', { count: result.imported.length }), 'success')
        })
        .catch((err) => {
          log.error('importRecomps failed', err)
          setStep({
            kind: 'error',
            message: ipcErrorMessage(err) || t('settingsRecomp.import.failed')
          })
        })
    },
    [chosen, t, toast]
  )

  const importing = step.kind === 'importing'
  const close = (): void => {
    if (!importing) onClose()
  }

  let body: ReactElement
  let footer: ReactElement
  if (step.kind === 'scanning') {
    body = (
      <p className="dialog__message">
        <Spinner size="sm" /> {t('settingsRecomp.import.looking')}
      </p>
    )
    footer = (
      <Button focusKey={`${KEY}:cancel`} onPress={close}>
        {t('settingsRecomp.import.cancel')}
      </Button>
    )
  } else if (step.kind === 'review') {
    const { scan } = step
    const folders = scan.picked.join(', ')
    body = (
      <>
        {scan.items.length ? (
          <p className="dialog__message">{t('settingsRecomp.import.lead', { folders })}</p>
        ) : (
          <p className="dialog__message">{t('settingsRecomp.import.nothing', { folders })}</p>
        )}
        {scan.ignored ? (
          <p className="dialog__message">
            {t('settingsRecomp.import.ignored', { count: scan.ignored })}
          </p>
        ) : null}
        <div className="recomp-import__list">
          {scan.items.map((item) => (
            <ImportRow
              key={item.folder}
              item={item}
              scan={scan}
              pick={picks[item.folder] ?? SKIP}
              picks={picks}
              onPick={(value) => setPicks((p) => ({ ...p, [item.folder]: value }))}
            />
          ))}
        </div>
        {scan.items.length ? (
          <p className="dialog__message">{t('settingsRecomp.import.afterNote')}</p>
        ) : null}
      </>
    )
    footer = (
      <>
        <Button focusKey={`${KEY}:cancel`} onPress={close}>
          {t('settingsRecomp.import.cancel')}
        </Button>
        <Button
          focusKey={`${KEY}:ok`}
          variant="primary"
          aria-disabled={!chosen.length}
          onPress={() => start(scan)}
        >
          {chosen.length
            ? t('settingsRecomp.import.start', { count: chosen.length })
            : t('settingsRecomp.import.startNone')}
        </Button>
      </>
    )
  } else if (step.kind === 'importing') {
    const total = progress?.bytesTotal ?? 0
    const copying = progress?.phase === 'copying' && total > 0
    const percent = copying ? Math.min(100, Math.round((progress!.bytesDone / total) * 100)) : null
    body = (
      <>
        <p className="dialog__message">
          {progress
            ? t('settingsRecomp.import.moving', {
                name: progress.name,
                index: progress.index,
                total: progress.total
              })
            : t('settingsRecomp.import.starting', { count: step.count })}
        </p>
        {progress ? <p className="dialog__message">{importPhaseText(progress)}</p> : null}
        {stopping ? <p className="dialog__message">{t('settingsRecomp.import.stopping')}</p> : null}
        <span
          className={percent === null ? 'dlq__bar dlq__bar--indeterminate' : 'dlq__bar'}
          style={percent === null ? undefined : ({ '--p': percent } as CSSProperties)}
          role="progressbar"
          aria-label={t('settingsRecomp.import.progressLabel')}
          aria-valuenow={percent ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </>
    )
    footer = (
      <Button
        focusKey={`${KEY}:stop`}
        aria-disabled={stopping}
        onPress={() => {
          setStopping(true)
          void api.cancelRecompImport().catch((err) => log.error('cancelRecompImport', err))
        }}
      >
        {t('settingsRecomp.import.stop')}
      </Button>
    )
  } else if (step.kind === 'done') {
    const { result } = step
    const unknown = result.imported.filter((r) => !r.versionKnown)
    body = (
      <>
        {result.imported.length ? (
          <p className="dialog__message">
            {t('settingsRecomp.import.doneImported', { count: result.imported.length })}
          </p>
        ) : null}
        {result.imported.map((r) => (
          <p key={r.folder} className="dialog__message u-truncate" title={r.dir}>
            {t('settingsRecomp.import.doneRow', { name: r.name, path: r.dir })}
          </p>
        ))}
        {result.imported
          .filter((r) => r.linksNotFixed > 0)
          .map((r) => (
            <p key={`links:${r.folder}`} className="dialog__message">
              {t('settingsRecomp.import.linksNotFixed', { count: r.linksNotFixed, path: r.dir })}
            </p>
          ))}
        {result.imported
          .filter((r) => r.leftInOld > 0)
          .map((r) => (
            <p key={`left:${r.folder}`} className="dialog__message">
              {t('settingsRecomp.import.leftInOld', { count: r.leftInOld, path: r.folder })}
            </p>
          ))}
        {unknown.length ? (
          <p className="dialog__message">
            {t('settingsRecomp.import.doneVersionUnknown', {
              names: unknown.map((r) => r.name).join(', ')
            })}
          </p>
        ) : null}
        {result.failed.length ? (
          <p className="dialog__message dialog__message--error">
            {t('settingsRecomp.import.doneFailed', { count: result.failed.length })}
          </p>
        ) : null}
        {result.failed.map((f) => (
          <p key={`fail:${f.folder}`} className="dialog__message dialog__message--error">
            {t('settingsRecomp.import.failedRow', { folder: f.folder, error: f.message })}
          </p>
        ))}
        {result.notStarted.length ? (
          <p className="dialog__message">
            {t('settingsRecomp.import.doneNotStarted', { count: result.notStarted.length })}
          </p>
        ) : null}
        {!result.imported.length && !result.failed.length && !result.notStarted.length ? (
          <p className="dialog__message">{t('settingsRecomp.import.doneNothing')}</p>
        ) : null}
      </>
    )
    footer = (
      <Button focusKey={`${KEY}:ok`} variant="primary" onPress={close}>
        {t('settingsRecomp.import.close')}
      </Button>
    )
  } else {
    body = <p className="dialog__message dialog__message--error">{step.message}</p>
    footer = (
      <Button focusKey={`${KEY}:ok`} variant="primary" onPress={close}>
        {t('settingsRecomp.import.close')}
      </Button>
    )
  }

  return (
    <Modal
      size="dialog"
      hideClose
      className="confirm-dialog recomp-import"
      focusKey={KEY}
      preferredChildFocusKey={`${KEY}:ok`}
      title={t('settingsRecomp.import.title')}
      onClose={close}
      closeOnBackdrop={!importing}
      footer={footer}
    >
      {body}
    </Modal>
  )
}

function ImportRow({
  item,
  scan,
  pick,
  picks,
  onPick
}: {
  item: RecompImportItem
  scan: RecompImportScan
  pick: string
  picks: Record<string, string>
  onPick: (value: string) => void
}): ReactElement {
  const t = useT()
  const [query, setQuery] = useState('')
  // A folder nothing (or only its name) matched may be any recompilation of the catalog: found by search.
  const anyOf = item.match === 'none' || item.match === 'title'
  const options = useMemo<SelectOption[]>(() => {
    const label = (c: { name: string; console: string }): string =>
      c.console ? `${c.name} (${c.console})` : c.name
    const own = item.choices.map((c) => ({ value: c.id, label: label(c) }))
    // The one picked by search shows as the pill's value.
    const searched =
      pick !== SKIP && pick !== CHOOSE_OTHER && !item.choices.some((c) => c.id === pick)
        ? scan.catalog.filter((c) => c.id === pick).map((c) => ({ value: c.id, label: label(c) }))
        : []
    return [
      { value: SKIP, label: t('settingsRecomp.import.skip') },
      ...own,
      ...searched,
      ...(anyOf ? [{ value: CHOOSE_OTHER, label: t('settingsRecomp.import.chooseOther') }] : [])
    ]
  }, [item, pick, anyOf, scan.catalog, t])
  const search = useMemo(
    () =>
      pick === CHOOSE_OTHER
        ? searchImportCatalog(
            scan.catalog,
            query,
            item.choices.map((c) => c.id)
          )
        : null,
    [pick, query, scan.catalog, item.choices]
  )
  const state = importRowState(item, pick, picks, scan.catalog)
  const launcher = t(`settingsRecomp.import.launcher.${item.launcher}`)
  const detail = [
    launcher,
    item.bytes !== null ? formatBytes(item.bytes) : null,
    item.version
      ? t('settingsRecomp.import.version', { version: item.version })
      : t('settingsRecomp.import.versionUnknown')
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="settings-row recomp-import__row">
      <div className="settings-row__text">
        <span className="settings-row__label">{item.name}</span>
        <span className="settings-row__desc u-truncate" title={item.folder}>
          {detail}
        </span>
        <span className="settings-row__desc u-truncate" title={item.folder}>
          {item.folder}
        </span>
        {state.message ? (
          <span
            className={state.ok ? 'settings-row__desc' : 'settings-row__desc recomp-import__warn'}
          >
            {state.message}
          </span>
        ) : null}
        {item.notes.map((n) => (
          <span key={n} className="settings-row__desc">
            {n}
          </span>
        ))}
        {search ? (
          <div className="recomp-import__search">
            <TextField
              label={t('settingsRecomp.import.searchLabel', { name: item.name })}
              placeholder={t('settingsRecomp.import.searchHint')}
              focusKey={`${KEY}:search:${item.folder}`}
              value={query}
              onChange={setQuery}
              clearable
              autoFocus
            />
            {query.trim() && !search.results.length ? (
              <span className="settings-row__desc">{t('settingsRecomp.import.searchNone')}</span>
            ) : null}
            <div className="recomp-import__results">
              {search.results.map((c) => (
                <Button
                  key={c.id}
                  focusKey={`${KEY}:result:${item.folder}:${c.id}`}
                  onPress={() => {
                    setQuery('')
                    onPick(c.id)
                  }}
                >
                  {c.console ? `${c.name} (${c.console})` : c.name}
                </Button>
              ))}
            </div>
            {search.more ? (
              <span className="settings-row__desc">
                {t('settingsRecomp.import.searchMore', { count: search.results.length })}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="settings-row__actions">
        {item.blocked ? null : (
          <SelectField
            variant="pill"
            label={t('settingsRecomp.import.pickLabel', { name: item.name })}
            focusKey={`${KEY}:pick:${item.folder}`}
            value={pick}
            options={options}
            onChange={onPick}
          />
        )}
      </div>
    </div>
  )
}
