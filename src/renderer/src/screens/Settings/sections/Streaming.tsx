import type {
  DiscoveredHost,
  PairedComputer,
  PairedHost,
  StreamResolution,
  StreamingHostStatus,
  StreamingSettings,
  StreamingStatus
} from '@shared/types'
import {
  Cast,
  Check,
  ExternalLink,
  FolderSync,
  Columns3,
  Star,
  Gamepad2,
  Hourglass,
  Gauge,
  Globe,
  KeyRound,
  Laptop,
  Library,
  Monitor,
  MonitorPlay,
  Network,
  Plus,
  RefreshCw,
  Search,
  Server,
  Timer,
  Trash2,
  X
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
import { api } from '../../../api/client'
import { Button } from '../../../components/Button'
import { Chip } from '../../../components/Chip'
import { SelectField, type SelectOption } from '../../../components/SelectField'
import { Spinner } from '../../../components/Spinner'
import { TextField } from '../../../components/TextField'
import { Toggle } from '../../../components/Toggle'
import { useActionHandlers } from '../../../hooks/useActionHandlers'
import { useT, type Translate } from '../../../i18n'
import { focusedKey, setFocus } from '../../../input/focus'
import { cx } from '../../../lib/cx'
import { formatRelativeDay } from '../../../lib/format'
import { ipcErrorMessage } from '../../../state/coop'
import { useStreamingStore } from '../../../state/streaming'
import { useUiStore } from '../../../state/ui'
import { fk, log, type SectionProps } from '../common'
import {
  countdown,
  emulationSyncLine,
  firewallHint,
  hostLine,
  lockedLine,
  pinInput,
  portForwardingLine,
  toolLine
} from './streamingText'

const SECTION = 'streaming'
const PIN_KEY = fk(SECTION, 'pin')
const ADDRESS_KEY = fk(SECTION, 'address')
const WAN_KEY = fk(SECTION, 'host-wan-field')
const ENTER_ADDRESS_KEY = fk(SECTION, 'enterAddress')
/** One key for Show PIN and Cancel: the button swaps in place, so focus stays on it. */
const PAIR_TOGGLE_KEY = fk(SECTION, 'pairToggle')

const VIGEMBUS_URL = 'https://github.com/nefarius/ViGEmBus/releases/latest'
const SUNSHINE_URL = 'https://github.com/LizardByte/Sunshine'
const MOONLIGHT_URL = 'https://github.com/moonlight-stream/moonlight-qt'

// The option lists are built per render: their automatic entries are words in the current language. Sizes, frame
// rates and bitrates are units, written the same in every language.
function resolutions(t: Translate): SelectOption<StreamResolution>[] {
  return [
    { value: 'auto', label: t('settingsStreaming.resolutionAuto') },
    { value: '720', label: '720p' },
    { value: '1080', label: '1080p' },
    { value: '1440', label: '1440p' },
    { value: '4K', label: '4K' }
  ]
}

type Fps = `${StreamingSettings['fps']}`
const FRAME_RATES: SelectOption<Fps>[] = [
  { value: '30', label: '30 fps' },
  { value: '60', label: '60 fps' },
  { value: '120', label: '120 fps' }
]

const BITRATE_VALUES = ['0', '10000', '20000', '40000', '80000', '150000']

function bitrates(t: Translate): SelectOption<string>[] {
  return BITRATE_VALUES.map((value) => ({
    value,
    label: value === '0' ? t('settingsStreaming.bitrateAuto') : `${Number(value) / 1000} Mbps`
  }))
}

/** A clock that ticks every second while `active` (the PIN countdown and the lock-out). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const tick = (): void => setNow(Date.now())
    // The first tick right away: the clock may be stale from the last time it ran.
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [active])
  return now
}

function openLink(url: string, t: Translate): void {
  api.openExternal(url).catch((err) => {
    log.error('openExternal failed', err)
    useUiStore.getState().toast(t('settingsStreaming.openLinkFailed'), 'error')
  })
}

function ProgressBar({ percent, label }: { percent?: number; label: string }): ReactElement {
  return (
    <span
      className={cx('update-progress', percent === undefined && 'update-progress--indeterminate')}
      style={percent !== undefined ? ({ '--p': percent } as CSSProperties) : undefined}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    />
  )
}

/**
 * Settings > Streaming: this PC as a host for other PlayOut computers (Sunshine, port forwarding, the pairing PIN,
 * paired computers), and this PC as a client of paired hosts (pairing with a host's PIN, Moonlight, stream quality).
 * Status comes from state/streaming.ts; the host itself follows `streaming.hostEnabled` in main.
 */
export function StreamingSection({ settings, patch }: SectionProps): ReactElement {
  const t = useT()
  const status = useStreamingStore((s) => s.status)
  useEffect(() => {
    void useStreamingStore.getState().load()
  }, [])
  const streaming = settings.streaming

  return (
    <>
      <div className="settings-section__header">
        <div>
          <h2 className="settings-section__title">{t('settingsStreaming.title')}</h2>
          <p className="settings-section__lead">{t('settingsStreaming.lead')}</p>
        </div>
      </div>
      <HostPart
        enabled={streaming.hostEnabled}
        shareLogins={streaming.shareLogins}
        host={status?.host ?? null}
        patch={patch}
      />
      <ClientPart settings={streaming} status={status} patch={patch} />
      <div className="section">
        <div className="section__title">{t('settingsStreaming.emulation.title')}</div>
        <Toggle
          focusKey={fk(SECTION, 'syncEmulation')}
          icon={<FolderSync />}
          label={t('settingsStreaming.emulation.sync.label')}
          description={t('settingsStreaming.emulation.sync.description')}
          checked={streaming.syncEmulation}
          onChange={(v) => patch({ streaming: { syncEmulation: v } })}
        />
      </div>
      <div className="section">
        <div className="section__title">{t('settingsStreaming.sync.title')}</div>
        <Toggle
          focusKey={fk(SECTION, 'syncLibraryTabs')}
          icon={<Columns3 />}
          label={t('settingsStreaming.sync.tabs.label')}
          description={t('settingsStreaming.sync.tabs.description')}
          checked={streaming.syncLibraryTabs}
          onChange={(v) => patch({ streaming: { syncLibraryTabs: v } })}
        />
        <Toggle
          focusKey={fk(SECTION, 'syncFavorites')}
          icon={<Star />}
          label={t('settingsStreaming.sync.favorites.label')}
          description={t('settingsStreaming.sync.favorites.description')}
          checked={streaming.syncFavorites}
          onChange={(v) => patch({ streaming: { syncFavorites: v } })}
        />
        <Toggle
          focusKey={fk(SECTION, 'syncPlaytime')}
          icon={<Hourglass />}
          label={t('settingsStreaming.sync.playtime.label')}
          description={t('settingsStreaming.sync.playtime.description')}
          checked={streaming.syncPlaytime}
          onChange={(v) => patch({ streaming: { syncPlaytime: v } })}
        />
      </div>
      <div className="section">
        <p className="settings-note">{t('settingsStreaming.tools')}</p>
        <div className="streaming-links">
          <Button
            focusKey={fk(SECTION, 'sunshineLink')}
            variant="ghost"
            iconRight={<ExternalLink />}
            onPress={() => openLink(SUNSHINE_URL, t)}
          >
            Sunshine
          </Button>
          <Button
            focusKey={fk(SECTION, 'moonlightLink')}
            variant="ghost"
            iconRight={<ExternalLink />}
            onPress={() => openLink(MOONLIGHT_URL, t)}
          >
            Moonlight
          </Button>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// This PC as host
// ---------------------------------------------------------------------------

function HostPart({
  enabled,
  shareLogins,
  host,
  patch
}: {
  enabled: boolean
  shareLogins: boolean
  host: StreamingHostStatus | null
  patch: SectionProps['patch']
}): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const openModal = useUiStore((s) => s.openModal)
  const [busy, setBusy] = useState(false)
  const pairing = host?.pairing ?? null
  const now = useNow(!!pairing || !!host?.lockedUntil)
  const locked = lockedLine(host?.lockedUntil, now)

  const run = useCallback(
    (what: string, call: () => Promise<StreamingStatus>) => {
      setBusy(true)
      call()
        .then((next) => useStreamingStore.setState({ status: next }))
        .catch((err) => {
          log.error(`${what} failed`, err)
          toast(ipcErrorMessage(err) || t('settingsStreaming.host.failed'), 'error')
        })
        .finally(() => setBusy(false))
    },
    [t, toast]
  )

  const removeClient = (client: PairedComputer): void => {
    openModal({
      type: 'confirm',
      title: t('settingsStreaming.host.removeClient.title', { name: client.name }),
      message: t('settingsStreaming.host.removeClient.message', { name: client.name }),
      confirmLabel: t('settingsStreaming.host.removeClient.confirm'),
      danger: true,
      onConfirm: () => run('removeStreamingClient', () => api.removeStreamingClient(client.id))
    })
  }

  const sunshine = host?.sunshine
  return (
    <div className="section">
      <div className="section__title">{t('settingsStreaming.host.title')}</div>
      <Toggle
        focusKey={fk(SECTION, 'host')}
        icon={<Cast />}
        label={t('settingsStreaming.host.enabled.label')}
        description={t('settingsStreaming.host.enabled.description')}
        checked={enabled}
        onChange={(v) => patch({ streaming: { hostEnabled: v } })}
      />
      {enabled ? (
        <>
          <Toggle
            focusKey={fk(SECTION, 'shareLogins')}
            icon={<KeyRound />}
            label={t('settingsStreaming.host.shareLogins.label')}
            description={t('settingsStreaming.host.shareLogins.description')}
            checked={shareLogins}
            onChange={(v) => patch({ streaming: { shareLogins: v } })}
          />
          {host?.state === 'error' && host.error ? (
            <p className="settings-note settings-note--missing">{host.error}</p>
          ) : null}
          <p className="settings-note">{firewallHint()}</p>
          <div className="settings-row">
            <span className="control__icon">
              <Server />
            </span>
            <div className="settings-row__text">
              <span className="settings-row__label">Sunshine</span>
              <span className="settings-row__desc" aria-live="polite">
                {toolLine(sunshine, 'Sunshine', t('settingsStreaming.host.sunshineMissing'))}
              </span>
              {sunshine?.state === 'downloading' ? (
                <ProgressBar
                  percent={sunshine.percent}
                  label={t('settingsStreaming.host.sunshineDownload')}
                />
              ) : null}
            </div>
          </div>
          <div className="settings-row">
            <span className="control__icon">
              <Globe />
            </span>
            <div className="settings-row__text">
              <span className="settings-row__label">
                {t('settingsStreaming.host.portForwarding')}
              </span>
              <span className="settings-row__desc" aria-live="polite">
                {portForwardingLine(host?.portForwarding, host?.port)}
              </span>
            </div>
          </div>
          <div className="settings-row">
            <span className="control__icon">
              <Network />
            </span>
            <div className="settings-row__text">
              <span className="settings-row__label">{t('settingsStreaming.host.address')}</span>
              <span className="settings-row__value">
                {host
                  ? t('settingsStreaming.host.addressWithPort', {
                      address: host.lanAddresses.length
                        ? host.lanAddresses.join(', ')
                        : t('settingsStreaming.host.notConnected'),
                      port: host.port
                    })
                  : t('settingsStreaming.host.notConnected')}
              </span>
            </div>
          </div>
          <div className="settings-row">
            <span className="control__icon">
              <KeyRound />
            </span>
            <div className="settings-row__text">
              <span className="settings-row__label">{t('settingsStreaming.host.pair.label')}</span>
              {pairing ? (
                <>
                  <span
                    className="streaming-pin"
                    aria-label={t('settingsStreaming.host.pair.pinLabel', {
                      digits: pairing.pin.split('').join(' ')
                    })}
                  >
                    {pairing.pin}
                  </span>
                  <span className="settings-row__desc" aria-live="polite">
                    {t('settingsStreaming.host.pair.enterPin', {
                      time: countdown(pairing.expiresAt, now)
                    })}
                  </span>
                </>
              ) : (
                <span className="settings-row__desc" aria-live="polite">
                  {locked ??
                    (!host?.listening
                      ? host?.state === 'error'
                        ? t('settingsStreaming.host.pair.afterProblem')
                        : t('settingsStreaming.host.pair.starting')
                      : t('settingsStreaming.host.pair.description'))}
                </span>
              )}
            </div>
            <div className="settings-row__actions">
              {pairing ? (
                <Button
                  focusKey={PAIR_TOGGLE_KEY}
                  icon={<X />}
                  aria-disabled={busy}
                  onPress={() => {
                    if (!busy) run('cancelStreamingPairing', () => api.cancelStreamingPairing())
                  }}
                >
                  {t('settingsStreaming.host.pair.cancel')}
                </Button>
              ) : (
                <Button
                  focusKey={PAIR_TOGGLE_KEY}
                  variant="primary"
                  icon={busy ? <Spinner size="sm" /> : <KeyRound />}
                  // The host service is enough: pairing (and ROM downloads) work while Sunshine is missing.
                  aria-disabled={busy || !!locked || !host?.listening}
                  onPress={() => {
                    if (!busy && !locked && host?.listening)
                      run('startStreamingPairing', () => api.startStreamingPairing())
                  }}
                >
                  {t('settingsStreaming.host.pair.showPin')}
                </Button>
              )}
            </div>
          </div>
          {host && !host.controllerDriver ? (
            <div className="settings-row">
              <span className="control__icon">
                <Gamepad2 />
              </span>
              <div className="settings-row__text">
                <span className="settings-row__label">
                  {t('settingsStreaming.host.controllers.label')}
                </span>
                <span className="settings-row__desc">
                  {t('settingsStreaming.host.controllers.description')}
                </span>
              </div>
              <div className="settings-row__actions">
                <Button
                  focusKey={fk(SECTION, 'vigembus')}
                  variant="ghost"
                  iconRight={<ExternalLink />}
                  onPress={() => openLink(VIGEMBUS_URL, t)}
                >
                  {t('settingsStreaming.host.controllers.get')}
                </Button>
              </div>
            </div>
          ) : null}
          {host?.streaming ? (
            <div className="settings-row">
              <span className="control__icon">
                <MonitorPlay />
              </span>
              <div className="settings-row__text">
                <span className="settings-row__label">
                  {t('settingsStreaming.host.nowStreaming')}
                </span>
                <span className="settings-row__value">
                  {t('settingsStreaming.host.streamingTo', {
                    title: host.streaming.title,
                    client: host.streaming.clientName
                  })}
                </span>
              </div>
            </div>
          ) : null}
          <div className="streaming-subtitle">{t('settingsStreaming.host.paired')}</div>
          {host?.clients.length ? (
            <div className="settings-card">
              {host.clients.map((client) => (
                <div key={client.id} className="settings-row">
                  <span className="control__icon">
                    <Laptop />
                  </span>
                  <div className="settings-row__text">
                    <span className="settings-row__label">{client.name}</span>
                    <span className="settings-row__desc">
                      {[
                        client.address,
                        t('settingsStreaming.host.pairedOn', {
                          when: formatRelativeDay(client.pairedAt).toLowerCase()
                        }),
                        client.lastSeen
                          ? t('settingsStreaming.host.lastConnected', {
                              when: formatRelativeDay(client.lastSeen).toLowerCase()
                            })
                          : ''
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  <div className="settings-row__actions">
                    <Button
                      focusKey={fk(SECTION, `client:${client.id}`)}
                      variant="ghost"
                      icon={<Trash2 />}
                      onPress={() => removeClient(client)}
                    >
                      {t('settingsStreaming.host.remove')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="settings-note">{t('settingsStreaming.host.noClients')}</p>
          )}
        </>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// This PC as client
// ---------------------------------------------------------------------------

type AddMode = 'closed' | 'find' | 'address'

function ClientPart({
  settings,
  status,
  patch
}: {
  settings: StreamingSettings
  status: StreamingStatus | null
  patch: SectionProps['patch']
}): ReactElement {
  const t = useT()
  const toast = useUiStore((s) => s.toast)
  const openModal = useUiStore((s) => s.openModal)
  const refreshRemote = useStreamingStore((s) => s.refreshRemote)
  const [mode, setMode] = useState<AddMode>('closed')
  const [finding, setFinding] = useState(false)
  const [found, setFound] = useState<DiscoveredHost[] | null>(null)
  const [address, setAddress] = useState('')
  const [pin, setPin] = useState('')
  const [pairing, setPairing] = useState(false)
  /** The last pairing failure, kept under the PIN field after its toast fades (wrong or expired PIN). */
  const [pairError, setPairError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // Focus moves once the field it targets has mounted (opening "Enter address" mounts both fields), so the request
  // waits for the render that the same handler's setMode causes.
  const focusTo = useRef<string | null>(null)
  useEffect(() => {
    if (!focusTo.current) return
    void setFocus(focusTo.current)
    focusTo.current = null
  })
  const hosts = status?.client.hosts ?? []
  const moonlight = status?.client.moonlight

  const find = useCallback(() => {
    setMode('find')
    setFinding(true)
    setFound(null)
    api
      .findStreamingHosts()
      .then(setFound)
      .catch((err) => {
        log.error('findStreamingHosts failed', err)
        toast(ipcErrorMessage(err) || t('settingsStreaming.client.findFailed'), 'error')
        setFound([])
      })
      .finally(() => setFinding(false))
  }, [t, toast])

  const choose = (host: DiscoveredHost): void => {
    setAddress(host.port ? `${host.address}:${host.port}` : host.address)
    setMode('address')
    setPin('')
    setPairError(null)
    focusTo.current = PIN_KEY
  }

  // The first-start prompt picked a host: its address is in the pair form (handled once per request, while rendering).
  const pairingRequest = useUiStore((s) => s.pairingRequest)
  const [handledPairing, setHandledPairing] = useState<number | null>(null)
  if (pairingRequest && pairingRequest.n !== handledPairing) {
    setHandledPairing(pairingRequest.n)
    setAddress(pairingRequest.address)
    setMode('address')
    setPin('')
    setPairError(null)
  }
  // Then focus goes to the PIN, once the form has mounted.
  useEffect(() => {
    if (handledPairing === null) return
    useUiStore.getState().clearPairingRequest()
    // After the Settings modal's own first focus (it opened with this request).
    const timer = setTimeout(() => void setFocus(PIN_KEY), 300)
    return () => clearTimeout(timer)
  }, [handledPairing])

  /** Close the pair form; focus lands on "Enter address" instead of jumping with the unmounted button. */
  const closeForm = (): void => {
    focusTo.current = ENTER_ADDRESS_KEY
    setMode('closed')
    setPin('')
    setPairError(null)
  }

  // The values come in as arguments: the on-screen keyboard's Done sets the field and submits in the same tick,
  // when this render's `pin` is still the old one.
  const pair = (pinValue = pin, addressValue = address): void => {
    if (pairing) return
    if (!addressValue.trim()) {
      toast(t('settingsStreaming.client.enterAddress'), 'error')
      void setFocus(ADDRESS_KEY)
      return
    }
    if (pinValue.length !== 4) {
      toast(t('settingsStreaming.client.enterPin'), 'error')
      void setFocus(PIN_KEY)
      return
    }
    setPairing(true)
    setPairError(null)
    api
      .pairStreamingHost(addressValue.trim(), pinValue)
      .then((host: PairedHost) => {
        toast(t('settingsStreaming.client.paired', { name: host.name }), 'success')
        closeForm()
        setFound(null)
        setAddress('')
        void useStreamingStore.getState().load()
      })
      .catch((err) => {
        log.warn('pairStreamingHost failed', err)
        const text = ipcErrorMessage(err) || t('settingsStreaming.client.pairFailed')
        toast(text, 'error', 8000)
        setPairError(text)
        setPin('')
        // Straight back to the PIN for the next try.
        void setFocus(PIN_KEY)
      })
      .finally(() => setPairing(false))
  }

  // Back closes the open pair form (or the list of found computers) first, not the whole of Settings.
  useActionHandlers(
    {
      back: () => {
        const key = focusedKey() ?? ''
        const inForm =
          [ADDRESS_KEY, PIN_KEY, fk(SECTION, 'pair'), fk(SECTION, 'pairClose')].includes(key) ||
          key.startsWith(fk(SECTION, 'found:'))
        if (!inForm) return false
        closeForm()
        return true
      }
    },
    mode !== 'closed'
  )

  const removeHost = (host: PairedHost): void => {
    openModal({
      type: 'confirm',
      title: t('settingsStreaming.client.removeHost.title', { name: host.name }),
      message: t('settingsStreaming.client.removeHost.message', { name: host.name }),
      confirmLabel: t('settingsStreaming.client.removeHost.confirm'),
      danger: true,
      onConfirm: () => {
        api
          .removeStreamingHost(host.id)
          .then((next) => useStreamingStore.setState({ status: next }))
          .catch((err) => {
            log.error('removeStreamingHost failed', err)
            toast(ipcErrorMessage(err) || t('settingsStreaming.client.removeHost.failed'), 'error')
          })
      }
    })
  }

  // A paired host's internet address (to reach it from another network), edited in place under its row.
  const [editingHost, setEditingHost] = useState<string | null>(null)
  const [wanText, setWanText] = useState('')
  const [savingWan, setSavingWan] = useState(false)
  const editAddress = (host: PairedHost): void => {
    setEditingHost(host.id)
    setWanText(host.wanAddress ?? '')
    focusTo.current = WAN_KEY
  }
  const saveAddress = (host: PairedHost): void => {
    if (savingWan) return
    setSavingWan(true)
    api
      .setStreamingHostAddress(host.id, wanText.trim() || null)
      .then((next) => {
        useStreamingStore.setState({ status: next })
        setEditingHost(null)
        void setFocus(fk(SECTION, `host-wan:${host.id}`))
        toast(
          wanText.trim()
            ? t('settingsStreaming.client.wan.saved', {
                name: host.name,
                address: wanText.trim()
              })
            : t('settingsStreaming.client.wan.cleared', { name: host.name }),
          'success'
        )
      })
      .catch((err) => {
        log.error('setStreamingHostAddress failed', err)
        toast(ipcErrorMessage(err) || t('settingsStreaming.client.wan.failed'), 'error')
      })
      .finally(() => setSavingWan(false))
  }

  // Back from the internet address field closes it, back onto its host's button (as the pair form closes).
  useActionHandlers(
    {
      back: () => {
        const key = focusedKey() ?? ''
        if (!editingHost || (key !== WAN_KEY && !key.startsWith(fk(SECTION, 'host-wan-save:'))))
          return false
        const host = editingHost
        setEditingHost(null)
        void setFocus(fk(SECTION, `host-wan:${host}`))
        return true
      }
    },
    editingHost !== null
  )

  const refresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    void refreshRemote().finally(() => setRefreshing(false))
  }

  const unpaired = found?.filter((h) => !h.paired) ?? []

  return (
    <div className="section">
      <div className="section__title">{t('settingsStreaming.client.title')}</div>
      {hosts.length ? (
        <div className="settings-card">
          {hosts.map((host) => (
            <div key={host.id} className="settings-row">
              <span className="control__icon">
                <Monitor />
              </span>
              <div className="settings-row__text">
                <span className="settings-row__label">
                  {host.name}
                  {host.online ? (
                    <Chip accent className="settings-row__chip">
                      {t('settingsStreaming.client.online')}
                    </Chip>
                  ) : (
                    <Chip className="settings-row__chip">
                      {t('settingsStreaming.client.offline')}
                    </Chip>
                  )}
                </span>
                <span className="settings-row__desc">{hostLine(host)}</span>
                {settings.syncEmulation && emulationSyncLine(host.emulationSync) ? (
                  <span className="settings-row__desc">
                    {emulationSyncLine(host.emulationSync)}
                  </span>
                ) : null}
              </div>
              <div className="settings-row__actions">
                <Button
                  focusKey={fk(SECTION, `host-wan:${host.id}`)}
                  variant="ghost"
                  icon={<Globe />}
                  onPress={() =>
                    editingHost === host.id ? setEditingHost(null) : editAddress(host)
                  }
                >
                  {t('settingsStreaming.client.wan.button')}
                </Button>
                <Button
                  focusKey={fk(SECTION, `host:${host.id}`)}
                  variant="ghost"
                  icon={<Trash2 />}
                  onPress={() => removeHost(host)}
                >
                  {t('settingsStreaming.client.remove')}
                </Button>
              </div>
              {editingHost === host.id ? (
                <div className="streaming-pair streaming-pair--wan">
                  <TextField
                    focusKey={WAN_KEY}
                    className="streaming-pair__address"
                    label={t('settingsStreaming.client.wan.label', { name: host.name })}
                    placeholder={t('settingsStreaming.client.wan.placeholder')}
                    oskTitle={t('settingsStreaming.client.wan.oskTitle', { name: host.name })}
                    value={wanText}
                    onChange={setWanText}
                    onSubmit={() => saveAddress(host)}
                  />
                  <div className="streaming-pair__actions">
                    <Button
                      focusKey={fk(SECTION, `host-wan-save:${host.id}`)}
                      variant="primary"
                      icon={savingWan ? <Spinner size="sm" /> : <Check />}
                      onPress={() => saveAddress(host)}
                      aria-disabled={savingWan}
                    >
                      {t('settingsStreaming.client.wan.save')}
                    </Button>
                  </div>
                  <p className="settings-note">
                    {t('settingsStreaming.client.wan.note', { name: host.name })}
                  </p>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="settings-note">{t('settingsStreaming.client.noHosts')}</p>
      )}
      <div className="settings-row">
        <span className="control__icon">
          <Plus />
        </span>
        <div className="settings-row__text">
          <span className="settings-row__label">{t('settingsStreaming.client.add.label')}</span>
          <span className="settings-row__desc">
            {t('settingsStreaming.client.add.description')}
          </span>
        </div>
        <div className="settings-row__actions">
          <Button
            focusKey={fk(SECTION, 'find')}
            icon={finding ? <Spinner size="sm" /> : <Search />}
            aria-disabled={finding}
            onPress={() => {
              if (!finding) find()
            }}
          >
            {t('settingsStreaming.client.add.find')}
          </Button>
          <Button
            focusKey={ENTER_ADDRESS_KEY}
            variant="ghost"
            onPress={() => {
              if (mode === 'address') {
                void setFocus(ADDRESS_KEY)
                return
              }
              focusTo.current = ADDRESS_KEY
              setMode('address')
            }}
          >
            {t('settingsStreaming.client.add.enterAddress')}
          </Button>
        </div>
      </div>
      {mode === 'find' && !finding && found ? (
        unpaired.length ? (
          <div className="settings-card">
            {unpaired.map((host) => (
              <div key={host.id} className="settings-row">
                <span className="control__icon">
                  <Monitor />
                </span>
                <div className="settings-row__text">
                  <span className="settings-row__label">{host.name}</span>
                  <span className="settings-row__desc">{host.address}</span>
                </div>
                <div className="settings-row__actions">
                  <Button
                    focusKey={fk(SECTION, `found:${host.id}`)}
                    variant="primary"
                    onPress={() => choose(host)}
                  >
                    {t('settingsStreaming.client.pair')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="settings-note">
            {found.length
              ? t('settingsStreaming.client.allPaired')
              : t('settingsStreaming.client.noneFound')}
          </p>
        )
      ) : null}
      {mode === 'address' ? (
        <div className="streaming-pair">
          <TextField
            focusKey={ADDRESS_KEY}
            className="streaming-pair__address"
            label={t('settingsStreaming.client.hostAddress')}
            placeholder="192.168.1.20"
            oskTitle={t('settingsStreaming.client.hostAddressOsk')}
            value={address}
            onChange={setAddress}
            onSubmit={() => void setFocus(PIN_KEY)}
          />
          <TextField
            focusKey={PIN_KEY}
            className="streaming-pair__pin"
            label={t('settingsStreaming.client.pin')}
            placeholder="0000"
            oskTitle={t('settingsStreaming.client.pinOsk')}
            value={pin}
            onChange={(v) => setPin(pinInput(v))}
            onSubmit={(v) => pair(pinInput(v))}
          />
          {pairError ? (
            <p className="settings-note settings-note--missing streaming-pair__error" role="alert">
              {pairError}
            </p>
          ) : null}
          <div className="streaming-pair__actions">
            <Button
              focusKey={fk(SECTION, 'pair')}
              variant="primary"
              icon={pairing ? <Spinner size="sm" /> : <KeyRound />}
              aria-disabled={pairing}
              onPress={() => pair()}
            >
              {t('settingsStreaming.client.pair')}
            </Button>
            <Button focusKey={fk(SECTION, 'pairClose')} variant="ghost" onPress={closeForm}>
              {t('settingsStreaming.client.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
      <div className="settings-row">
        <span className="control__icon">
          <MonitorPlay />
        </span>
        <div className="settings-row__text">
          <span className="settings-row__label">Moonlight</span>
          <span className="settings-row__desc" aria-live="polite">
            {toolLine(moonlight, 'Moonlight', t('settingsStreaming.client.moonlightMissing'))}
          </span>
          {moonlight?.state === 'downloading' ? (
            <ProgressBar
              percent={moonlight.percent}
              label={t('settingsStreaming.client.moonlightDownload')}
            />
          ) : null}
        </div>
        <div className="settings-row__actions">
          <Button
            focusKey={fk(SECTION, 'refresh')}
            variant="ghost"
            icon={refreshing ? <Spinner size="sm" /> : <RefreshCw />}
            aria-disabled={refreshing || !hosts.length}
            onPress={() => {
              if (hosts.length) refresh()
            }}
          >
            {t('settingsStreaming.client.refreshGames')}
          </Button>
        </div>
      </div>
      <Toggle
        focusKey={fk(SECTION, 'showHostGames')}
        icon={<Library />}
        label={t('settingsStreaming.client.showHostGames.label')}
        description={t('settingsStreaming.client.showHostGames.description')}
        checked={settings.showHostGames}
        onChange={(v) => patch({ streaming: { showHostGames: v } })}
      />
      <SelectField
        focusKey={fk(SECTION, 'resolution')}
        icon={<Monitor />}
        label={t('settingsStreaming.client.resolution.label')}
        description={t('settingsStreaming.client.resolution.description')}
        value={settings.resolution}
        options={resolutions(t)}
        onChange={(v) => patch({ streaming: { resolution: v } })}
      />
      <SelectField
        focusKey={fk(SECTION, 'fps')}
        icon={<Timer />}
        label={t('settingsStreaming.client.fps')}
        value={String(settings.fps) as Fps}
        options={FRAME_RATES}
        onChange={(v) => patch({ streaming: { fps: Number(v) as StreamingSettings['fps'] } })}
      />
      <SelectField
        focusKey={fk(SECTION, 'bitrate')}
        icon={<Gauge />}
        label={t('settingsStreaming.client.bitrate.label')}
        description={t('settingsStreaming.client.bitrate.description')}
        value={
          BITRATE_VALUES.includes(String(settings.bitrateKbps)) ? String(settings.bitrateKbps) : '0'
        }
        options={bitrates(t)}
        onChange={(v) => patch({ streaming: { bitrateKbps: Number(v) } })}
      />
    </div>
  )
}
