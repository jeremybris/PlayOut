import type { CoopTwoPlayerLayout } from '@shared/types'
import { Columns2, Download, Keyboard, Rows2, Users } from 'lucide-react'
import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { SelectField, type SelectOption } from '../../components/SelectField'
import { Spinner } from '../../components/Spinner'
import { Toggle } from '../../components/Toggle'
import { useT, type Translate } from '../../i18n'
import { cx } from '../../lib/cx'
import { coopScanBar } from '../../lib/coop'
import { createLog } from '../../lib/log'
import { ipcErrorMessage, refreshCoopStatus, useCoopStore } from '../../state/coop'
import { useUiStore } from '../../state/ui'
import { fk, type SectionProps } from './common'
import { SplitLayoutArt } from './SplitLayoutArt'

const log = createLog('coop-settings')
const SECTION = 'library'

// Shown as pictures of the split screen; the words are what assistive tech reads (built per render, in the current
// language).
function twoPlayerOptions(t: Translate): SelectOption<CoopTwoPlayerLayout>[] {
  return [
    {
      value: 'stacked',
      label: t('settings.coop.twoPlayer.stacked'),
      art: <SplitLayoutArt layout="stacked" />
    },
    {
      value: 'sideBySide',
      label: t('settings.coop.twoPlayer.sideBySide'),
      art: <SplitLayoutArt layout="sideBySide" />
    }
  ]
}

/**
 * Settings > Library > Co-Op: download every Nucleus Co-op handler (kept zipped; a game's handler is extracted when it
 * is first played in Co-Op), and whether the keyboard and mouse count as a player.
 */
export function CoopSection({ settings, patch }: SectionProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const status = useCoopStore((s) => s.status)
  const progress = useCoopStore((s) => s.progress)
  const [downloading, setDownloading] = useState(false)
  useEffect(() => {
    void refreshCoopStatus()
  }, [])

  const download = useCallback(() => {
    setDownloading(true)
    api
      .downloadCoopHandlers()
      .then((next) => {
        useCoopStore.setState({ status: next })
        toast(t('settings.coop.downloaded', { count: next.games }), 'success')
      })
      .catch((err) => {
        log.error('downloadCoopHandlers failed', err)
        toast(ipcErrorMessage(err) || t('settings.coop.downloadFailed'), 'error')
      })
      .finally(() => setDownloading(false))
  }, [t, toast])

  const bar = progress.stage !== 'tools' ? coopScanBar(progress) : null
  const busy = downloading || !!status?.busy
  const summary = !status
    ? t('settings.coop.loading')
    : status.handlers === 0
      ? t('settings.coop.notDownloaded')
      : t('settings.coop.summary', {
          handlers: t('settings.coop.handlerCount', { count: status.handlers }),
          games: t('settings.coop.gameCount', { count: status.games })
        })

  return (
    <div className="section">
      <div className="section__title">{t('settings.coop.title')}</div>
      <div className="settings-row">
        <span className="control__icon">
          <Users />
        </span>
        <div className="settings-row__text">
          <span className="settings-row__label">{t('settings.coop.handlers')}</span>
          <span className="settings-row__desc" aria-live="polite">
            {bar ? bar.label : summary}
          </span>
          {bar ? (
            <span
              className={cx('update-progress', bar.total <= 1 && 'update-progress--indeterminate')}
              style={
                bar.total > 1
                  ? ({ '--p': Math.min(100, (bar.done / bar.total) * 100) } as CSSProperties)
                  : undefined
              }
              role="progressbar"
              aria-label={t('settings.coop.progressLabel')}
              aria-valuemin={0}
              aria-valuemax={bar.total}
              aria-valuenow={Math.min(bar.done, bar.total)}
            />
          ) : null}
        </div>
        <div className="settings-row__actions">
          <Button
            focusKey={fk(SECTION, 'coopDownload')}
            icon={busy ? <Spinner size="sm" /> : <Download />}
            aria-disabled={busy}
            onPress={() => {
              if (!busy) download()
            }}
          >
            {status?.handlers ? t('settings.coop.updateAll') : t('settings.coop.downloadAll')}
          </Button>
        </div>
      </div>
      <SelectField
        focusKey={fk(SECTION, 'coopTwoPlayerLayout')}
        icon={settings.library.coopTwoPlayerLayout === 'sideBySide' ? <Columns2 /> : <Rows2 />}
        label={t('settings.coop.twoPlayer.label')}
        description={t('settings.coop.twoPlayer.description')}
        value={settings.library.coopTwoPlayerLayout}
        options={twoPlayerOptions(t)}
        onChange={(v) => patch({ library: { coopTwoPlayerLayout: v } })}
      />
      <Toggle
        focusKey={fk(SECTION, 'coopKeyboardMouse')}
        icon={<Keyboard />}
        label={t('settings.coop.keyboardMouse.label')}
        description={t('settings.coop.keyboardMouse.description')}
        checked={settings.library.coopKeyboardMouse}
        onChange={(v) => patch({ library: { coopKeyboardMouse: v } })}
      />
    </div>
  )
}
