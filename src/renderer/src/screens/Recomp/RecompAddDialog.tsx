import type { RecompRepoCheck } from '@shared/recomp'
import { AlertTriangle, ClipboardPaste, Plus, Search, Star } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { Chip } from '../../components/Chip'
import { Modal } from '../../components/Modal'
import { SelectField } from '../../components/SelectField'
import { Spinner } from '../../components/Spinner'
import { TextField } from '../../components/TextField'
import { useT } from '../../i18n'
import { formatBytes } from '../../lib/format'
import { createLog } from '../../lib/log'
import { ipcErrorMessage } from '../../state/coop'
import { useUiStore } from '../../state/ui'
import { canAddChecked, createCheckGate } from './browseView'

const log = createLog('recomp-add')
const KEY = 'recompadd'
const key = (part: string): string => `${KEY}:${part}`

export interface RecompAddDialogProps {
  onClose: () => void
  /** Added: the browser reads its list again and shows this recompilation. */
  onAdded: (id: string) => void
  /** The repository is in the browser already: show that recompilation. */
  onShow: (id: string) => void
}

/**
 * The Recompilations browser's Add: a GitHub repository (pasted, typed with the on-screen keyboard, or from the
 * clipboard with Paste) is checked once per press of Check (main's checkRecompRepo: public, not listed yet, a release
 * with a Windows download; nothing is downloaded), then the user names its game and console and presses Add. It shows
 * at once as "Added by you"; main sends it for approval (or publishes it, for the owner).
 */
export function RecompAddDialog({ onClose, onAdded, onShow }: RecompAddDialogProps): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const [url, setUrl] = useState('')
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<RecompRepoCheck | null>(null)
  const [game, setGame] = useState('')
  const [systemId, setSystemId] = useState('other')
  const [adding, setAdding] = useState(false)
  const ok = check?.ok ? check : null

  // The answer of a Check is shown only while the link is the one it checked (createCheckGate).
  const [gate] = useState(createCheckGate)

  const changeUrl = (next: string): void => {
    setUrl(next)
    // Another repository: it is checked again before it can be added, and a Check still running is dropped.
    gate.cancel()
    setChecking(false)
    setCheck(null)
  }
  const runCheck = (value = url): void => {
    if (gate.pending() || !value.trim()) return
    const n = gate.begin()
    setChecking(true)
    setCheck(null)
    api
      .checkRecompRepo(value.trim())
      .then((result) => {
        if (!gate.isCurrent(n)) return
        setCheck(result)
        if (result.ok) {
          setGame(result.game)
          setSystemId('other')
        }
      })
      .catch((err) => {
        log.error('checkRecompRepo failed', err)
        if (!gate.isCurrent(n)) return
        toast(
          t('recomp.addDialog.checkFailed', {
            error: ipcErrorMessage(err) || t('recomp.browser.unknownError')
          }),
          'error'
        )
      })
      .finally(() => {
        if (gate.finish(n)) setChecking(false)
      })
  }
  const paste = (): void => {
    api
      .readRecompClipboard()
      .then((text) => {
        if (!text) return
        changeUrl(text)
        runCheck(text)
      })
      .catch((err) => {
        log.error('readRecompClipboard failed', err)
        toast(t('recomp.addDialog.pasteFailed'), 'error')
      })
  }
  const add = (): void => {
    if (!ok || adding || !canAddChecked(ok, game)) return
    setAdding(true)
    api
      .addRecomp({ id: ok.id, game: game.trim(), systemId })
      .then((result) => {
        toast(t('recomp.addDialog.added', { name: ok.repo }), 'success')
        onAdded(result.id)
        onClose()
      })
      .catch((err) => {
        log.error('addRecomp failed', err)
        setAdding(false)
        toast(
          t('recomp.addDialog.addFailed', {
            error: ipcErrorMessage(err) || t('recomp.browser.unknownError')
          }),
          'error'
        )
      })
  }

  const consoles = (ok?.consoles ?? []).map((c) => ({ value: c.id, label: c.name }))

  return createPortal(
    <Modal
      size="dialog"
      focusKey={KEY}
      preferredChildFocusKey={key('url')}
      title={t('recomp.addDialog.title')}
      subtitle={t('recomp.addDialog.subtitle')}
      onClose={onClose}
      aria-label={t('recomp.addDialog.title')}
      footer={
        <>
          <Button focusKey={key('cancel')} variant="ghost" onPress={onClose}>
            {t('recomp.addDialog.cancel')}
          </Button>
          <Button
            focusKey={key('add')}
            variant="primary"
            icon={adding ? <Spinner size="sm" /> : <Plus />}
            disabled={!ok || adding || !canAddChecked(ok, game)}
            onPress={add}
          >
            {adding ? t('recomp.addDialog.adding') : t('recomp.addDialog.add')}
          </Button>
        </>
      }
    >
      <div className="recomp-add">
        <div className="recomp-add__row">
          <TextField
            focusKey={key('url')}
            className="recomp-add__url"
            label={t('recomp.addDialog.repo')}
            type="url"
            placeholder={t('recomp.addDialog.repoPlaceholder')}
            oskTitle={t('recomp.addDialog.repoOsk')}
            value={url}
            onChange={changeUrl}
            onSubmit={(v) => runCheck(v)}
          />
          <Button focusKey={key('paste')} icon={<ClipboardPaste />} onPress={paste}>
            {t('recomp.addDialog.paste')}
          </Button>
          <Button
            focusKey={key('check')}
            icon={checking ? <Spinner size="sm" /> : <Search />}
            disabled={checking || !url.trim()}
            onPress={() => runCheck()}
          >
            {checking ? t('recomp.addDialog.checking') : t('recomp.addDialog.check')}
          </Button>
        </div>
        <p className="recomp-add__note">{t('recomp.addDialog.safety')}</p>
        {check && !check.ok ? (
          <div className="recomp-add__problem" role="alert">
            <AlertTriangle aria-hidden="true" />
            <span className="u-grow">{check.message}</span>
            {check.existingId ? (
              <Button
                focusKey={key('show')}
                onPress={() => {
                  onShow(check.existingId!)
                  onClose()
                }}
              >
                {t('recomp.addDialog.showIt')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {ok ? (
          <>
            <section className="recomp-add__repo" aria-label={ok.repo}>
              <div className="recomp-add__repo-head">
                <span className="recomp-add__repo-name u-grow">{ok.repo}</span>
                <span className="recomp-add__stars">
                  <Star aria-hidden="true" />
                  {ok.stars !== null
                    ? t('recomp.addDialog.stars', { stars: ok.stars.toLocaleString() })
                    : '—'}
                </span>
              </div>
              {ok.description ? <p className="recomp-add__desc">{ok.description}</p> : null}
              <p className="recomp-add__release">
                {t('recomp.addDialog.release', {
                  tag: ok.tag,
                  asset: ok.asset.name,
                  size: formatBytes(ok.asset.size)
                })}
              </p>
              {ok.archived || ok.fork ? (
                <div className="recomp-add__warnings">
                  {ok.archived ? (
                    <Chip className="recomp-browser-entry__warn" icon={<AlertTriangle />}>
                      {t('recomp.addDialog.archived')}
                    </Chip>
                  ) : null}
                  {ok.fork ? (
                    <Chip className="recomp-browser-entry__warn" icon={<AlertTriangle />}>
                      {t('recomp.addDialog.fork')}
                    </Chip>
                  ) : null}
                </div>
              ) : null}
            </section>
            <TextField
              focusKey={key('game')}
              label={t('recomp.addDialog.game')}
              oskTitle={t('recomp.addDialog.gameOsk')}
              value={game}
              onChange={setGame}
            />
            <SelectField
              focusKey={key('console')}
              label={t('recomp.addDialog.console')}
              description={t('recomp.addDialog.consoleHint')}
              value={systemId}
              options={consoles}
              onChange={setSystemId}
            />
          </>
        ) : null}
      </div>
    </Modal>,
    document.body
  )
}
