import { METADATA_REPO_URL, type MetadataSuggestion } from '@shared/metadata-cloud'
import { Check, CloudDownload, ExternalLink, Link2, RefreshCw, Send, X } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { api } from '../../../api/client'
import { Button } from '../../../components/Button'
import { Spinner } from '../../../components/Spinner'
import { TextField } from '../../../components/TextField'
import { Toggle } from '../../../components/Toggle'
import { useT } from '../../../i18n'
import { setFocus } from '../../../input/focus'
import { ipcErrorMessage } from '../../../state/coop'
import { useMetadataCloudStore } from '../../../state/metadataCloud'
import { useUiStore } from '../../../state/ui'
import { fk, log } from '../common'
import { cloudSyncText, editsGoText } from './metadataCloudText'

const SECTION = 'metadata'

type Busy = 'sync' | 'relay' | 'share' | 'suggestions' | `approve:${number}` | `reject:${number}`

/** One open suggestion: its game, each field's cloud value -> suggested value, Approve / Reject. */
function SuggestionCard({
  item,
  busy,
  onResolve,
  onOpen
}: {
  item: MetadataSuggestion
  busy: Busy | null
  onResolve: (item: MetadataSuggestion, action: 'approve' | 'reject') => void
  onOpen: (url: string) => void
}): ReactElement {
  const t = useT()
  const working = busy === `approve:${item.number}` || busy === `reject:${item.number}`
  return (
    <div className="settings-card cloud-suggestion">
      <div className="settings-row">
        <div className="settings-row__text">
          <span className="settings-row__label">{item.gameTitle}</span>
          <span className="settings-row__desc">
            #{item.number} · {new Date(item.createdAt).toLocaleDateString()}
            {item.key ? ` · ${item.key}` : ''}
          </span>
        </div>
        <div className="settings-row__actions">
          <Button
            focusKey={fk(SECTION, `cloud:approve:${item.number}`)}
            variant="primary"
            icon={busy === `approve:${item.number}` ? <Spinner size="sm" /> : <Check />}
            disabled={working || !!item.error}
            onPress={() => onResolve(item, 'approve')}
          >
            {t('settingsCloud.suggestions.approve')}
          </Button>
          <Button
            focusKey={fk(SECTION, `cloud:reject:${item.number}`)}
            icon={busy === `reject:${item.number}` ? <Spinner size="sm" /> : <X />}
            disabled={working}
            onPress={() => onResolve(item, 'reject')}
          >
            {t('settingsCloud.suggestions.reject')}
          </Button>
          <Button
            focusKey={fk(SECTION, `cloud:open:${item.number}`)}
            variant="ghost"
            iconRight={<ExternalLink />}
            onPress={() => onOpen(item.url)}
            aria-label={t('settingsCloud.suggestions.openLabel', { number: item.number })}
          >
            GitHub
          </Button>
        </div>
      </div>
      {item.error ? (
        <p className="settings-note settings-note--missing">{item.error}</p>
      ) : (
        <ul className="cloud-suggestion__changes">
          {item.changes.map((c) => (
            <li key={c.field}>
              <span className="cloud-suggestion__field">{c.label}</span>
              <span className="cloud-suggestion__before">{c.before}</span>
              <span aria-hidden="true">→</span>
              <span className="cloud-suggestion__after">{c.after}</span>
            </li>
          ))}
          {item.changes.length === 0 ? <li>{t('settingsCloud.suggestions.noChange')}</li> : null}
        </ul>
      )}
    </div>
  )
}

/**
 * Settings › Metadata › Cloud metadata: the PlayOut metadata cloud's status, the relay that turns edits into
 * suggestions and, on a PC that already has the owner's GitHub token saved, the open suggestions to approve or
 * reject (the token field is no longer shown: every PC suggests its edits).
 */
export function CloudMetadata({ onOpen }: { onOpen: (url: string) => void }): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const status = useMetadataCloudStore((s) => s.status)
  const suggestions = useMetadataCloudStore((s) => s.suggestions)
  const suggestionsError = useMetadataCloudStore((s) => s.suggestionsError)
  const loadingSuggestions = useMetadataCloudStore((s) => s.loadingSuggestions)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [relayDraft, setRelayDraft] = useState<string | null>(null)
  const owner = status?.owner === true

  useEffect(() => {
    void useMetadataCloudStore.getState().load()
  }, [])
  useEffect(() => {
    if (owner) void useMetadataCloudStore.getState().loadSuggestions()
  }, [owner])

  const run = useCallback(
    async (what: Busy, task: () => Promise<unknown>, done?: string): Promise<boolean> => {
      setBusy(what)
      try {
        await task()
        if (done) toast(done, 'success')
        return true
      } catch (err) {
        log.error(`metadata cloud ${what} failed`, err)
        toast(ipcErrorMessage(err), 'error', 8000)
        return false
      } finally {
        setBusy(null)
      }
    },
    [toast]
  )

  const saveRelay = (): void => {
    if (relayDraft === null) return
    void run(
      'relay',
      () => api.setMetadataCloudConfig({ relayUrl: relayDraft }),
      t('settingsCloud.toasts.relaySaved')
    ).then((ok) => ok && setRelayDraft(null))
  }

  const resolve = (item: MetadataSuggestion, action: 'approve' | 'reject'): void => {
    void run(
      `${action}:${item.number}`,
      async () => {
        await api.resolveMetadataSuggestion(item.number, action, item.headSha)
        // Its card goes away: the controller moves to the next card's same button (else the previous card's, else
        // Refresh) instead of dropping to the section's first control. A card that cannot be approved gets Reject.
        const list = useMetadataCloudStore.getState().suggestions ?? []
        const at = list.findIndex((s) => s.number === item.number)
        const near = at >= 0 ? (list[at + 1] ?? list[at - 1]) : undefined
        const button = near && action === 'approve' && near.error ? 'reject' : action
        void setFocus(
          near
            ? fk(SECTION, `cloud:${button}:${near.number}`)
            : fk(SECTION, 'cloud:suggestionsRefresh')
        )
        useMetadataCloudStore.getState().removeSuggestion(item.number)
      },
      action === 'approve'
        ? t('settingsCloud.toasts.approved', { game: item.gameTitle })
        : t('settingsCloud.toasts.rejected', { game: item.gameTitle })
    )
  }

  if (!status)
    return (
      <div className="section">
        <div className="section__title">{t('settingsCloud.title')}</div>
        <div className="settings-spinner">
          <Spinner />
        </div>
      </div>
    )

  const relayValue = relayDraft ?? status.relayUrl

  return (
    <div className="section">
      <div className="credential-title">
        <div className="section__title">{t('settingsCloud.title')}</div>
        <Button
          focusKey={fk(SECTION, 'cloud:repo')}
          variant="ghost"
          iconRight={<ExternalLink />}
          onPress={() => onOpen(METADATA_REPO_URL)}
          aria-label={t('settingsCloud.repositoryLabel')}
        >
          {t('settingsCloud.repository')}
        </Button>
      </div>
      <p className="settings-note">{t('settingsCloud.note')}</p>

      <div className="settings-row">
        <span className="control__icon">
          <CloudDownload />
        </span>
        <div className="settings-row__text">
          <span className="settings-row__label">{t('settingsCloud.cloud.label')}</span>
          <span className="settings-row__desc" aria-live="polite">
            {cloudSyncText(status)}
          </span>
          {status.lastError ? (
            <span className="settings-row__desc">
              {t('settingsCloud.cloud.lastError', { error: status.lastError })}
            </span>
          ) : null}
        </div>
        <div className="settings-row__actions">
          <Button
            focusKey={fk(SECTION, 'cloud:sync')}
            icon={busy === 'sync' || status.syncing ? <Spinner size="sm" /> : <RefreshCw />}
            disabled={busy === 'sync' || status.syncing}
            onPress={() => void run('sync', () => api.syncMetadataCloud())}
          >
            {t('settingsCloud.cloud.checkNow')}
          </Button>
        </div>
      </div>

      {!owner ? (
        <Toggle
          focusKey={fk(SECTION, 'cloud:suggest')}
          icon={<Send />}
          label={t('settingsCloud.suggest.label')}
          description={editsGoText(status)}
          checked={status.suggestEdits}
          onChange={(v) => void run('relay', () => api.setMetadataCloudConfig({ suggestEdits: v }))}
        />
      ) : (
        <p className="settings-note">{editsGoText(status)}</p>
      )}

      <div className="cloud-field">
        <TextField
          className="cloud-field__input"
          focusKey={fk(SECTION, 'cloud:relay')}
          label={t('settingsCloud.relay.label')}
          type="url"
          value={relayValue}
          placeholder={status.sharedRelayUrl || t('settingsCloud.relay.placeholder')}
          clearable
          onChange={setRelayDraft}
          onSubmit={saveRelay}
        />
        <Button
          focusKey={fk(SECTION, 'cloud:relaySave')}
          icon={busy === 'relay' ? <Spinner size="sm" /> : <Check />}
          disabled={relayDraft === null || busy === 'relay'}
          onPress={saveRelay}
        >
          {t('settingsCloud.relay.save')}
        </Button>
        {owner && status.relayUrl && status.relayUrl !== status.sharedRelayUrl ? (
          <Button
            focusKey={fk(SECTION, 'cloud:relayShare')}
            icon={busy === 'share' ? <Spinner size="sm" /> : <Link2 />}
            disabled={busy === 'share'}
            onPress={() =>
              void run(
                'share',
                () => api.shareMetadataRelayUrl(),
                t('settingsCloud.toasts.relayShared')
              )
            }
          >
            {t('settingsCloud.relay.share')}
          </Button>
        ) : null}
      </div>
      <p className="settings-note">
        {status.sharedRelayUrl && !status.relayUrl
          ? t('settingsCloud.relay.usingShared', { url: status.sharedRelayUrl })
          : t('settingsCloud.relay.note')}
      </p>

      {owner ? (
        <>
          <div className="credential-title">
            <div className="section__title">
              {suggestions
                ? t('settingsCloud.suggestions.titleCount', { number: suggestions.length })
                : t('settingsCloud.suggestions.title')}
            </div>
            <Button
              focusKey={fk(SECTION, 'cloud:suggestionsRefresh')}
              variant="ghost"
              icon={loadingSuggestions ? <Spinner size="sm" /> : <RefreshCw />}
              disabled={loadingSuggestions}
              onPress={() => void useMetadataCloudStore.getState().loadSuggestions()}
            >
              {t('settingsCloud.suggestions.refresh')}
            </Button>
          </div>
          {suggestionsError ? (
            <p className="settings-note settings-note--missing" role="status">
              {suggestionsError}
            </p>
          ) : null}
          {suggestions && suggestions.length === 0 ? (
            <p className="settings-note">{t('settingsCloud.suggestions.none')}</p>
          ) : null}
          {suggestions?.map((item) => (
            <SuggestionCard
              key={item.number}
              item={item}
              busy={busy}
              onResolve={resolve}
              onOpen={onOpen}
            />
          ))}
        </>
      ) : null}
    </div>
  )
}
