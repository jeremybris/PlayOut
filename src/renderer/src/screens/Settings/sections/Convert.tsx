import {
  convertNoteText,
  CONVERT_PLATFORMS,
  convertPlatform,
  directionFormats,
  type ConvertItem,
  type ConvertMissing
} from '@shared/convert'
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  FileStack,
  FolderOpen,
  Gamepad2,
  Repeat,
  Square,
  Wand2
} from 'lucide-react'
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { api } from '../../../api/client'
import { Button } from '../../../components/Button'
import { PlatformBadge } from '../../../components/PlatformBadge'
import { SelectField } from '../../../components/SelectField'
import { systemIconSlug } from '@shared/platform-icons'
import { Spinner } from '../../../components/Spinner'
import { useT, type Translate } from '../../../i18n'
import { cx } from '../../../lib/cx'
import { ipcErrorMessage } from '../../../state/coop'
import { refreshConvertStatus, useConvertStore } from '../../../state/convert'
import { useUiStore } from '../../../state/ui'
import { fk, log, shortPath } from '../common'

const SECTION = 'convert'

const PLATFORM_OPTIONS = CONVERT_PLATFORMS.map((p) => ({ value: p.id, label: p.label }))

function stateIcon(item: ConvertItem): ReactElement {
  switch (item.state) {
    case 'running':
      return <Spinner size="sm" />
    case 'done':
      return <CircleCheck className="convert-item__icon convert-item__icon--done" />
    case 'failed':
      return <CircleAlert className="convert-item__icon convert-item__icon--failed" />
    case 'skipped':
    case 'stopped':
      return <CircleSlash className="convert-item__icon" />
    default:
      return <FileStack className="convert-item__icon" />
  }
}

/** A file's state in words, in the current language. */
function stateWord(t: Translate, state: ConvertItem['state']): string {
  switch (state) {
    case 'queued':
      return t('settingsConvert.state.queued')
    case 'running':
      return t('settingsConvert.state.running')
    case 'done':
      return t('settingsConvert.state.done')
    case 'failed':
      return t('settingsConvert.state.failed')
    case 'skipped':
      return t('settingsConvert.state.skipped')
    case 'stopped':
      return t('settingsConvert.state.stopped')
  }
}

/**
 * Settings › Convert: ROM and emulated games converted from one format to another by Game Format Converter
 * (downloaded on first use). A platform, one of its format pairs, the arrow for the direction, the files (several of
 * one format), Convert. Results land next to the originals, which go to the Recycle Bin once verified.
 */
export function ConvertSection(): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const status = useConvertStore((s) => s.status)
  const [platformId, setPlatformId] = useState(CONVERT_PLATFORMS[0]!.id)
  const platform = convertPlatform(platformId) ?? CONVERT_PLATFORMS[0]!
  const [pairId, setPairId] = useState(platform.pairs[0]!.id)
  const pair = platform.pairs.find((p) => p.id === pairId) ?? platform.pairs[0]!
  const [reversed, setReversed] = useState(false)
  const [paths, setPaths] = useState<string[]>([])
  const [missing, setMissing] = useState<ConvertMissing[]>([])
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    refreshConvertStatus().catch((err) => log.error('getConvertStatus failed', err))
  }, [])

  // Each system's name and maker, for the same badge its games' cards carry.
  const [systems, setSystems] = useState<Map<string, { name: string; manufacturer?: string }>>(
    () => new Map()
  )
  useEffect(() => {
    let live = true
    api
      .getSystems()
      .then((list) => {
        if (live) setSystems(new Map(list.map((sys) => [sys.id, sys])))
      })
      .catch((err) => log.error('getSystems failed', err))
    return () => {
      live = false
    }
  }, [])
  const system = systems.get(platform.id)
  const platformBadge = (
    <PlatformBadge
      icon={systemIconSlug(platform.id, system?.manufacturer ?? platform.manufacturer)}
      systemId={platform.id}
      name={system?.name ?? platform.label}
      size="sm"
    />
  )

  const flipped = reversed && !!pair.backward
  const formats = directionFormats(pair, flipped)!
  const platformKey = platform.id
  const pairKey = pair.id
  const request = { platformId: platformKey, pairId: pairKey, reversed: flipped }

  // What the direction needs that is missing (keys, emulators): asked whenever the direction changes, and again when
  // PlayOut's window comes back (the user may have just put a key in place or installed an emulator).
  useEffect(() => {
    let live = true
    const ask = (): void => {
      api
        .checkConvert({ platformId: platformKey, pairId: pairKey, reversed: flipped })
        .then((next) => {
          if (live) setMissing(next)
        })
        .catch((err) => {
          log.error('checkConvert failed', err)
          if (live) setMissing([])
        })
    }
    ask()
    window.addEventListener('focus', ask)
    return () => {
      live = false
      window.removeEventListener('focus', ask)
    }
  }, [platformKey, pairKey, flipped])

  const pickPlatform = (id: string): void => {
    const next = convertPlatform(id)
    if (!next) return
    setPlatformId(id)
    setPairId(next.pairs[0]!.id)
    setReversed(false)
    setPaths([])
  }

  const pickPair = (id: string): void => {
    setPairId(id)
    setReversed(false)
    setPaths([])
  }

  // The arrow flips the direction; the picked files were the other format, so they are let go.
  const flip = (): void => {
    if (!pair.backward || status?.running) return
    setReversed((r) => !r)
    setPaths([])
  }

  const choose = (): void => {
    if (status?.running) return
    api
      .chooseConvertPaths(request)
      .then((picked) => {
        if (picked.length) setPaths(picked)
      })
      .catch((err) => {
        log.error('chooseConvertPaths failed', err)
        toast(t('settingsConvert.toasts.pickerFailed'), 'error')
      })
  }

  const running = !!status?.running
  const blocking = missing.filter((m) => m.blocking)

  // Main checks the keys again when a run starts, and its refusal names where the missing one goes.
  const start = (): void => {
    if (!paths.length || starting) return
    setStarting(true)
    api
      .startConvert({ ...request, paths })
      .then((next) => {
        useConvertStore.setState({ status: next })
        setPaths([])
      })
      .catch((err) => {
        log.error('startConvert failed', err)
        toast(ipcErrorMessage(err) || t('settingsConvert.toasts.startFailed'), 'error')
      })
      .finally(() => setStarting(false))
  }

  const stop = (): void => {
    api.stopConvert().catch((err) => log.error('stopConvert failed', err))
  }

  const openPlace = (missingOne: ConvertMissing): void => {
    api.openConvertPlace(missingOne.need).catch(() => {
      toast(t('settingsConvert.missing.putIn', { place: missingOne.place }), 'info')
    })
  }

  const items = status?.items ?? []
  const finished = items.filter((i) => i.state !== 'queued' && i.state !== 'running').length
  const current = items.find((i) => i.state === 'running')
  const downloading = status?.downloading
  const pairOptions = platform.pairs.map((p) => ({
    value: p.id,
    label: `${p.left.label} ${p.backward ? '↔' : '→'} ${p.right.label}`
  }))

  return (
    <>
      <div className="section">
        <div className="section__title">{t('settingsConvert.title')}</div>
        <p className="settings-note">
          {t('settingsConvert.note')}
          {status?.tool
            ? ` ${t('settingsConvert.toolReady', { version: status.tool.version })}`
            : ''}
        </p>
        <SelectField
          focusKey={fk(SECTION, 'platform')}
          icon={<Gamepad2 />}
          label={t('settingsConvert.platform')}
          valueIcon={platformBadge}
          value={platform.id}
          options={PLATFORM_OPTIONS}
          onChange={pickPlatform}
          disabled={running}
        />
        <SelectField
          focusKey={fk(SECTION, 'pair')}
          icon={<Repeat />}
          label={t('settingsConvert.conversion')}
          value={pair.id}
          options={pairOptions}
          onChange={pickPair}
          disabled={running}
        />
        <div className="convert-direction" aria-label={t('settingsConvert.direction.label')}>
          <span
            className={cx(
              'convert-direction__format',
              !flipped && 'convert-direction__format--from'
            )}
          >
            {pair.left.label}
          </span>
          <Button
            focusKey={fk(SECTION, 'direction')}
            className="convert-direction__arrow"
            icon={flipped ? <ArrowLeft /> : <ArrowRight />}
            onPress={flip}
            aria-disabled={!pair.backward || running}
            aria-label={
              pair.backward
                ? t('settingsConvert.direction.reversible', {
                    from: formats.from.label,
                    to: formats.to.label
                  })
                : t('settingsConvert.direction.oneWay', {
                    from: formats.from.label,
                    to: formats.to.label
                  })
            }
            title={
              pair.backward
                ? t('settingsConvert.direction.reverseTitle')
                : t('settingsConvert.direction.oneWayTitle')
            }
          />
          <span
            className={cx(
              'convert-direction__format',
              flipped && 'convert-direction__format--from'
            )}
          >
            {pair.right.label}
          </span>
        </div>
        {/* The formats keep their sides; the arrow points from the files picked to what they become. */}
        <p className="settings-note convert-direction__hint">
          {flipped
            ? t('settingsConvert.direction.hintRightToLeft', {
                from: pair.right.label,
                to: pair.left.label
              })
            : t('settingsConvert.direction.hintLeftToRight', {
                from: pair.left.label,
                to: pair.right.label
              })}
          {formats.direction.note ? ` ${convertNoteText(formats.direction.note, t)}` : ''}
        </p>
        {missing.map((m) => (
          <div
            key={m.need}
            className={cx('convert-missing', m.blocking && 'convert-missing--blocking')}
            role="alert"
          >
            <CircleAlert className="convert-missing__icon" />
            <div className="convert-missing__text">
              <span>{m.message}</span>
              <span className="convert-missing__place">
                {t('settingsConvert.missing.place', { place: m.place })}
              </span>
            </div>
            <Button
              focusKey={fk(SECTION, `missing:${m.need}`)}
              variant="ghost"
              icon={<FolderOpen />}
              onPress={() => openPlace(m)}
            >
              {t('settingsConvert.missing.openFolder')}
            </Button>
          </div>
        ))}
        <div className="settings-row">
          <span className="control__icon">
            <FileStack />
          </span>
          <div className="settings-row__text">
            <span className="settings-row__label">
              {paths.length
                ? formats.from.folder
                  ? t('settingsConvert.files.foldersChosen', { count: paths.length })
                  : t('settingsConvert.files.filesChosen', { count: paths.length })
                : formats.from.folder
                  ? t('settingsConvert.files.chooseFolders')
                  : t('settingsConvert.files.chooseFiles')}
            </span>
            <span className="settings-row__desc">
              {paths.length
                ? paths.slice(0, 3).map(shortPath).join(' · ') +
                  (paths.length > 3
                    ? ` · ${t('settingsConvert.files.more', { count: paths.length - 3 })}`
                    : '')
                : formats.from.folder
                  ? t('settingsConvert.files.hintFolders', {
                      platform: platform.label,
                      to: formats.to.label
                    })
                  : t('settingsConvert.files.hintFiles', {
                      format: formats.from.label,
                      platform: platform.label,
                      to: formats.to.label
                    })}
            </span>
          </div>
          <div className="settings-row__actions">
            <Button
              focusKey={fk(SECTION, 'choose')}
              icon={<FolderOpen />}
              onPress={choose}
              aria-disabled={running}
            >
              {t('settingsConvert.files.choose')}
            </Button>
            {/* One button that turns into Stop while converting: focus stays on it either way (gamepad). */}
            <Button
              focusKey={fk(SECTION, 'run')}
              variant={running ? 'danger' : 'primary'}
              icon={running ? <Square /> : starting ? <Spinner size="sm" /> : <Wand2 />}
              onPress={running ? stop : start}
              aria-disabled={!running && (!paths.length || starting || blocking.length > 0)}
            >
              {running ? t('settingsConvert.files.stop') : t('settingsConvert.files.convert')}
            </Button>
          </div>
        </div>
      </div>

      {downloading || items.length || status?.error ? (
        <div className="section">
          <div className="section__title">
            {running ? t('settingsConvert.run.converting') : t('settingsConvert.run.lastRun')}
          </div>
          {downloading ? (
            <div className="settings-row">
              <div className="settings-row__text">
                <span className="settings-row__label">{t('settingsConvert.run.downloading')}</span>
                <span
                  className={cx(
                    'update-progress',
                    downloading.fraction === null && 'update-progress--indeterminate'
                  )}
                  style={{ '--p': Math.round((downloading.fraction ?? 0) * 100) } as CSSProperties}
                />
              </div>
            </div>
          ) : null}
          {status?.error ? (
            <p className="settings-note settings-note--missing">{status.error}</p>
          ) : null}
          {running && items.length ? (
            <div className="settings-row">
              <div className="settings-row__text">
                <span className="settings-row__label" aria-live="polite">
                  {`${t('settingsConvert.run.done', { finished, total: items.length })}${current ? ` · ${shortPath(current.path)}` : ''}${current?.progress !== undefined ? ` · ${Math.floor(current.progress * 100)}%` : ''}`}
                </span>
                <span
                  className="update-progress"
                  style={
                    {
                      '--p': Math.round(
                        ((finished + (current?.progress ?? 0)) / items.length) * 100
                      )
                    } as CSSProperties
                  }
                />
              </div>
            </div>
          ) : null}
          <ul className="convert-items">
            {items.map((item) => (
              <li key={item.path} className={cx('convert-item', `convert-item--${item.state}`)}>
                {stateIcon(item)}
                <div className="convert-item__text">
                  <span className="convert-item__name">{shortPath(item.path)}</span>
                  <span className="convert-item__detail">
                    {stateWord(t, item.state)}
                    {item.detail ? ` · ${item.detail}` : ''}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  )
}
